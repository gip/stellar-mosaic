// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MosaicBridge} from "../src/MosaicBridge.sol";
import {MockUSDC, FeeOnTransferToken} from "./mocks/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract MosaicBridgeTest is Test {
    uint256 internal constant BN254_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    MosaicBridge bridge;
    MockUSDC usdc;

    address admin = makeAddr("admin");
    address alice = makeAddr("alice");

    uint32 constant USDC_ASSET_ID = 1;
    bytes32 constant OWNER_TAG = bytes32(uint256(0x1234)); // a small, valid Fr element

    // mirror of the contract event for expectEmit
    event Shielded(
        uint64 indexed depositId,
        uint32 indexed assetId,
        uint256 amount,
        bytes32 ownerTag,
        address token,
        address from
    );
    event AssetRegistered(uint32 indexed assetId, address indexed token);

    function setUp() public {
        usdc = new MockUSDC();
        uint32[] memory assetIds = new uint32[](1);
        address[] memory tokens = new address[](1);
        assetIds[0] = USDC_ASSET_ID;
        tokens[0] = address(usdc);
        bridge = new MosaicBridge(admin, assetIds, tokens);

        usdc.mint(alice, 1_000_000_000); // 1,000 USDC (6 dp)
        vm.prank(alice);
        usdc.approve(address(bridge), type(uint256).max);
    }

    // ---- registry ----

    function test_registerAsset_setsMapping() public view {
        assertEq(bridge.assetToken(USDC_ASSET_ID), address(usdc));
    }

    function test_registerAsset_onlyOwner() public {
        MockUSDC other = new MockUSDC();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        bridge.registerAsset(2, address(other));
    }

    function test_registerAsset_noRebind() public {
        vm.expectRevert(abi.encodeWithSelector(MosaicBridge.AssetAlreadyRegistered.selector, USDC_ASSET_ID));
        vm.prank(admin);
        bridge.registerAsset(USDC_ASSET_ID, address(0xBEEF));
    }

    function test_registerAsset_rejectsZeroToken() public {
        vm.expectRevert(MosaicBridge.ZeroToken.selector);
        vm.prank(admin);
        bridge.registerAsset(9, address(0));
    }

    function test_constructor_registersAssetsAtomically() public {
        MockUSDC second = new MockUSDC();
        uint32[] memory assetIds = new uint32[](2);
        address[] memory tokens = new address[](2);
        assetIds[0] = 7;
        assetIds[1] = 8;
        tokens[0] = address(usdc);
        tokens[1] = address(second);

        MosaicBridge deployed = new MosaicBridge(admin, assetIds, tokens);
        assertEq(deployed.owner(), admin);
        assertEq(deployed.assetToken(7), address(usdc));
        assertEq(deployed.assetToken(8), address(second));
    }

    function test_constructor_rejectsMismatchedArrays() public {
        uint32[] memory assetIds = new uint32[](1);
        address[] memory tokens = new address[](0);
        vm.expectRevert(MosaicBridge.InvalidAssetArrays.selector);
        new MosaicBridge(admin, assetIds, tokens);
    }

    function test_constructor_rejectsDuplicateAssetIds() public {
        uint32[] memory assetIds = new uint32[](2);
        address[] memory tokens = new address[](2);
        assetIds[0] = 7;
        assetIds[1] = 7;
        tokens[0] = address(usdc);
        tokens[1] = address(0xBEEF);
        vm.expectRevert(abi.encodeWithSelector(MosaicBridge.AssetAlreadyRegistered.selector, uint32(7)));
        new MosaicBridge(admin, assetIds, tokens);
    }

    function test_constructor_rejectsZeroToken() public {
        uint32[] memory assetIds = new uint32[](1);
        address[] memory tokens = new address[](1);
        assetIds[0] = 7;
        vm.expectRevert(MosaicBridge.ZeroToken.selector);
        new MosaicBridge(admin, assetIds, tokens);
    }

    // ---- shield happy path ----

    function test_shield_movesTokensAndEmits() public {
        uint256 amount = 100_000_000; // 100 USDC

        vm.expectEmit(true, true, true, true);
        emit Shielded(0, USDC_ASSET_ID, amount, OWNER_TAG, address(usdc), alice);

        vm.prank(alice);
        uint64 id = bridge.shield(USDC_ASSET_ID, amount, OWNER_TAG);

        assertEq(id, 0);
        assertEq(bridge.depositCount(), 1);
        assertEq(usdc.balanceOf(address(bridge)), amount);
        assertEq(usdc.balanceOf(alice), 1_000_000_000 - amount);
    }

    function test_shield_storesDepositRecord() public {
        uint256 amount = 100_000_000;
        vm.prank(alice);
        bridge.shield(USDC_ASSET_ID, amount, OWNER_TAG);

        // The OP-compatible proof reads this record via eth_getProof.
        (uint32 assetId, uint256 amt, bytes32 ownerTag) = bridge.deposits(0);
        assertEq(assetId, USDC_ASSET_ID);
        assertEq(amt, amount);
        assertEq(ownerTag, OWNER_TAG);
    }

    function test_shield_incrementsDepositId() public {
        vm.startPrank(alice);
        uint64 id0 = bridge.shield(USDC_ASSET_ID, 10_000_000, OWNER_TAG);
        uint64 id1 = bridge.shield(USDC_ASSET_ID, 20_000_000, bytes32(uint256(0x5678)));
        vm.stopPrank();
        assertEq(id0, 0);
        assertEq(id1, 1);
        assertEq(usdc.balanceOf(address(bridge)), 30_000_000);
    }

    // ---- shield validation ----

    function test_shield_revertsUnregisteredAsset() public {
        vm.expectRevert(abi.encodeWithSelector(MosaicBridge.AssetNotRegistered.selector, uint32(42)));
        vm.prank(alice);
        bridge.shield(42, 1_000_000, OWNER_TAG);
    }

    function test_shield_revertsZeroAmount() public {
        vm.expectRevert(MosaicBridge.InvalidAmount.selector);
        vm.prank(alice);
        bridge.shield(USDC_ASSET_ID, 0, OWNER_TAG);
    }

    function test_shield_revertsAmountAboveI128Max() public {
        uint256 tooBig = uint256(uint128(type(int128).max)) + 1;
        vm.expectRevert(MosaicBridge.InvalidAmount.selector);
        vm.prank(alice);
        bridge.shield(USDC_ASSET_ID, tooBig, OWNER_TAG);
    }

    function test_shield_revertsOwnerTagAtFieldModulus() public {
        bytes32 badTag = bytes32(BN254_SCALAR_FIELD); // == r, out of range
        vm.expectRevert(MosaicBridge.InvalidOwnerTag.selector);
        vm.prank(alice);
        bridge.shield(USDC_ASSET_ID, 1_000_000, badTag);
    }

    function test_shield_acceptsOwnerTagJustBelowModulus() public {
        bytes32 maxTag = bytes32(BN254_SCALAR_FIELD - 1);
        vm.prank(alice);
        uint64 id = bridge.shield(USDC_ASSET_ID, 1_000_000, maxTag);
        assertEq(id, 0);
    }

    // ---- pause ----

    function test_shield_revertsWhenPaused() public {
        vm.prank(admin);
        bridge.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(alice);
        bridge.shield(USDC_ASSET_ID, 1_000_000, OWNER_TAG);
    }

    function test_pause_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        bridge.pause();
    }

    // ---- fee-on-transfer: emitted amount must equal RECEIVED, not requested ----

    function test_shield_recordsReceivedAmountNotRequested() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        vm.prank(admin);
        bridge.registerAsset(7, address(fee));
        fee.mint(alice, 1_000_000);
        vm.prank(alice);
        fee.approve(address(bridge), type(uint256).max);

        uint256 requested = 1_000_000;
        uint256 expectedReceived = requested - (requested * 100) / 10_000; // minus 1%

        vm.expectEmit(true, true, true, true);
        emit Shielded(0, 7, expectedReceived, OWNER_TAG, address(fee), alice);

        vm.prank(alice);
        bridge.shield(7, requested, OWNER_TAG);

        assertEq(fee.balanceOf(address(bridge)), expectedReceived);
    }
}
