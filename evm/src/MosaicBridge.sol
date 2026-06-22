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

    /// Protocol asset id (identical to the Stellar `register_asset` id) -> ERC20 token on Base.
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

    event AssetRegistered(uint32 indexed assetId, address indexed token);
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
    error InvalidAmount();
    error InvalidOwnerTag();

    constructor(address admin) Ownable(admin) {}

    /// Bind a protocol asset id to its ERC20 token. Permanent (a rebind would silently change what a
    /// minted note means), matching the Stellar registry's no-rebind rule.
    function registerAsset(uint32 assetId, address token) external onlyOwner {
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
        address token = assetToken[assetId];
        if (token == address(0)) revert AssetNotRegistered(assetId);
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

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
