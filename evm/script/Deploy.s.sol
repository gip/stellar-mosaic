// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {MosaicBridge} from "../src/MosaicBridge.sol";

/// Deploy MosaicBridge to Base Sepolia and register USDC.
///
/// Env:
///   PRIVATE_KEY        deployer/admin key
///   USDC_ADDRESS       ERC20 token to register (default: Circle USDC on Base Sepolia)
///   USDC_ASSET_ID      protocol asset id matching the Stellar register_asset id (default 1)
///
/// Run:
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
contract Deploy is Script {
    // Circle's testnet USDC on Base Sepolia.
    address constant DEFAULT_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external returns (MosaicBridge bridge) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address admin = vm.addr(pk);
        address usdc = vm.envOr("USDC_ADDRESS", DEFAULT_USDC);
        uint32 assetId = uint32(vm.envOr("USDC_ASSET_ID", uint256(1)));

        vm.startBroadcast(pk);
        bridge = new MosaicBridge(admin);
        bridge.registerAsset(assetId, usdc);
        vm.stopBroadcast();

        console2.log("MosaicBridge:", address(bridge));
        console2.log("admin:", admin);
        console2.log("USDC:", usdc);
        console2.log("assetId:", assetId);
    }
}
