// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MosaicBridge — shield assets on Base into a Stellar Mosaic note (one-way deposit).
///
/// The Base counterpart of Soroban `settlement.shield`. A user locks an ERC20 (e.g. USDC) here and
/// names an opaque `ownerTag`; the contract emits a `Shielded` event carrying exactly the data
/// needed to recreate the note on Stellar — `Poseidon(assetId, amount, ownerTag)`. A RISC Zero /
/// Boundless (Steel) proof attests this event, and the Stellar settlement contract verifies that
/// proof and inserts the AssetNote leaf. See `docs/base-bridge.md`.
///
/// This phase is a ONE-WAY peg: tokens are locked here and the Stellar note is treated as fungible
/// with native Stellar custody (Base-USDC is assumed equivalent to Stellar-USDC). There is no
/// withdraw-back-to-Base path yet; the locked balance is the off-chain solvency backstop.
contract MosaicBridge is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// BN254 scalar field modulus r. `ownerTag` and the note leaf are Fr elements (the circuits'
    /// Poseidon2 is over Fr), so `ownerTag` MUST be < r or the leaf cannot be reproduced on Stellar.
    uint256 internal constant BN254_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// Stellar note amounts are `i128`; reject deposits that could not be represented there.
    uint256 internal constant MAX_AMOUNT = uint256(uint128(type(int128).max));

    /// Sentinel `assetToken` value marking an asset whose Base side is NATIVE ETH (deposited via
    /// `shieldNative`, not an ERC20). The canonical "mock ETH" pseudo-address; chosen because it is
    /// non-zero (so it is distinguishable from an unregistered id, whose map default is `address(0)`)
    /// and cannot be a real deployed token. On Stellar this maps to a `BaseRepresented` asset.
    address internal constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// Protocol asset id (identical to the Stellar `register_asset` id) -> token on Base. The value
    /// is an ERC20 address, or the `NATIVE` sentinel for native ETH. `address(0)` = unregistered.
    mapping(uint32 assetId => address token) public assetToken;

    /// Monotonic deposit counter. `depositId` is the single-use replay key consumed on Stellar
    /// (scoped by this bridge's chain id + address, which the proof's journal binds).
    uint64 public depositCount;

    /// The note descriptor recorded for each deposit. Base is an OP-stack chain, so the RISC Zero
    /// proof reads this from CONTRACT STATE via a Steel `eth_getProof` view call (event/receipt
    /// proofs can't work on OP — every block carries a type-0x7e deposit tx the receipt decoder
    /// rejects). The public getter `deposits(uint64)` is what the bridge guest proves.
    struct Deposit {
        uint32 assetId;
        uint256 amount;
        bytes32 ownerTag;
    }

    mapping(uint64 depositId => Deposit) public deposits;

    /// Does this bridge gate deposits behind the allowlist? Fixed at deployment (flipping an open
    /// bridge to permissioned would strand nothing here — deposits are one-way — but the mode
    /// mirrors the paired Stellar desk, whose flag IS load-bearing, so both are immutable choices).
    /// Deliberately a regular storage variable, not `immutable`: trustless desk verification
    /// compares this contract's runtime bytecode against the vendored artifact, and immutables are
    /// embedded in runtime code.
    bool public permissioned;

    /// Addresses that may deposit when `permissioned`. Add-only (matching the Stellar desk's
    /// allowlist, where removal would strand shielded funds behind the unshield gate).
    mapping(address account => bool) public allowed;

    event AssetRegistered(uint32 indexed assetId, address indexed token);
    event AllowedAdded(address indexed member);
    event Shielded(
        uint64 indexed depositId,
        uint32 indexed assetId,
        uint256 amount,
        bytes32 ownerTag,
        address token,
        address from
    );

    error AssetNotRegistered(uint32 assetId);
    error AssetAlreadyRegistered(uint32 assetId);
    error ZeroToken();
    error InvalidAssetArrays();
    error InvalidAmount();
    error InvalidOwnerTag();
    /// Wrong deposit route for the asset's Base side: ERC20 `shield` on a native asset, or
    /// `shieldNative` on an ERC20 asset.
    error WrongDepositRoute(uint32 assetId);
    /// Permissioned bridge: the depositor is not on the allowlist.
    error NotAllowed(address account);
    /// Allowlist operation on an open (non-permissioned) bridge.
    error NotPermissioned();

    /// Deploy a bridge and bind its initial asset registry atomically. This keeps browser-based
    /// desk creation to one paid transaction and prevents a half-configured bridge from being
    /// attached to its Stellar settlement contract. `permissioned_` + `initialAllowed` seed the
    /// optional deposit allowlist (empty + false = open bridge, the default).
    constructor(
        address admin,
        uint32[] memory assetIds,
        address[] memory tokens,
        bool permissioned_,
        address[] memory initialAllowed
    ) Ownable(admin) {
        if (assetIds.length != tokens.length) revert InvalidAssetArrays();
        if (!permissioned_ && initialAllowed.length != 0) revert NotPermissioned();
        permissioned = permissioned_;
        for (uint256 i = 0; i < initialAllowed.length; i++) {
            _addAllowed(initialAllowed[i]);
        }
        for (uint256 i = 0; i < assetIds.length; i++) {
            _registerAsset(assetIds[i], tokens[i]);
        }
    }

    /// Add a depositor to a permissioned bridge's allowlist. Add-only: there is no removal,
    /// matching the paired Stellar desk. Idempotent.
    function addAllowed(address member) external onlyOwner {
        if (!permissioned) revert NotPermissioned();
        _addAllowed(member);
    }

    function _addAllowed(address member) internal {
        if (member == address(0)) revert NotAllowed(address(0));
        allowed[member] = true;
        emit AllowedAdded(member);
    }

    function _requireAllowed() internal view {
        if (permissioned && !allowed[msg.sender]) revert NotAllowed(msg.sender);
    }

    /// Bind a protocol asset id to its ERC20 token. Permanent (a rebind would silently change what a
    /// minted note means), matching the Stellar registry's no-rebind rule.
    function registerAsset(uint32 assetId, address token) external onlyOwner {
        _registerAsset(assetId, token);
    }

    function _registerAsset(uint32 assetId, address token) internal {
        if (token == address(0)) revert ZeroToken();
        if (assetToken[assetId] != address(0)) revert AssetAlreadyRegistered(assetId);
        assetToken[assetId] = token;
        emit AssetRegistered(assetId, token);
    }

    /// Shield `amount` of `assetId`'s token into custody and emit the note descriptor.
    ///
    /// The emitted `amount` is the balance actually received (delta-measured), so a fee-on-transfer
    /// or rebasing token can never cause Stellar to mint more than was truly locked. For USDC the
    /// received amount equals `amount`.
    function shield(uint32 assetId, uint256 amount, bytes32 ownerTag)
        external
        nonReentrant
        whenNotPaused
        returns (uint64 depositId)
    {
        _requireAllowed();
        address token = assetToken[assetId];
        if (token == address(0)) revert AssetNotRegistered(assetId);
        if (token == NATIVE) revert WrongDepositRoute(assetId); // native ETH -> use shieldNative
        if (amount == 0 || amount > MAX_AMOUNT) revert InvalidAmount();
        if (uint256(ownerTag) >= BN254_SCALAR_FIELD) revert InvalidOwnerTag();

        // Pull tokens into custody and measure what actually arrived (checks-effects-interactions:
        // the only external call is the transfer, guarded by nonReentrant).
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        if (received == 0 || received > MAX_AMOUNT) revert InvalidAmount();

        depositId = depositCount++;
        // Record the note in state so the OP-compatible Steel proof can read it via eth_getProof.
        deposits[depositId] = Deposit({assetId: assetId, amount: received, ownerTag: ownerTag});
        emit Shielded(depositId, assetId, received, ownerTag, token, msg.sender);
    }

    /// Shield native ETH (`msg.value`) into custody and emit the note descriptor. The Base-side
    /// counterpart of `shield` for an asset whose Base form is native ETH (its Stellar form is a
    /// `BaseRepresented` note). The deposit struct/journal the bridge guest proves is identical to an
    /// ERC20 shield — only the funds source differs — so the guest image id is unchanged.
    function shieldNative(uint32 assetId, bytes32 ownerTag)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint64 depositId)
    {
        _requireAllowed();
        address token = assetToken[assetId];
        if (token == address(0)) revert AssetNotRegistered(assetId);
        if (token != NATIVE) revert WrongDepositRoute(assetId); // ERC20 asset -> use shield
        uint256 amount = msg.value;
        if (amount == 0 || amount > MAX_AMOUNT) revert InvalidAmount();
        if (uint256(ownerTag) >= BN254_SCALAR_FIELD) revert InvalidOwnerTag();

        // ETH is already in custody (the contract holds `msg.value`); there is no transfer to measure.
        depositId = depositCount++;
        deposits[depositId] = Deposit({assetId: assetId, amount: amount, ownerTag: ownerTag});
        emit Shielded(depositId, assetId, amount, ownerTag, NATIVE, msg.sender);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
