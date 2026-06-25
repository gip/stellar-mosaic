// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {MosaicBridge} from "../src/MosaicBridge.sol";

/// Deploy MosaicBridge to Base Sepolia and register every asset the bridge should support.
///
/// The constructor registers all `(assetId, token)` pairs atomically, so the full asset set is
/// supplied here as parallel comma-separated lists. Defaults match what the desk UI deploys: Circle
/// USDC (asset 1) and native ETH (asset 3, the `NATIVE` sentinel).
///
/// Env:
///   PRIVATE_KEY    deployer/admin key (required)
///   ASSET_IDS      comma-separated protocol asset ids, e.g. "1,3" (must match the Stellar ids)
///   ASSET_TOKENS   comma-separated Base token addresses, parallel to ASSET_IDS. Use the NATIVE
///                  sentinel 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE for native ETH.
///
/// Run:
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
contract Deploy is Script {
    // Circle's testnet USDC on Base Sepolia.
    address constant DEFAULT_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    // Native-ETH sentinel — must equal MosaicBridge.NATIVE.
    address constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    function run() external returns (MosaicBridge bridge) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address admin = vm.addr(pk);

        uint256[] memory defaultIds = new uint256[](2);
        defaultIds[0] = 1; // USDC
        defaultIds[1] = 3; // native ETH
        address[] memory defaultTokens = new address[](2);
        defaultTokens[0] = DEFAULT_USDC;
        defaultTokens[1] = NATIVE;

        uint256[] memory rawIds = vm.envOr("ASSET_IDS", ",", defaultIds);
        address[] memory tokens = vm.envOr("ASSET_TOKENS", ",", defaultTokens);
        require(rawIds.length == tokens.length, "ASSET_IDS/ASSET_TOKENS length mismatch");
        require(rawIds.length > 0, "no assets to register");

        uint32[] memory assetIds = new uint32[](rawIds.length);
        for (uint256 i = 0; i < rawIds.length; i++) {
            require(rawIds[i] <= type(uint32).max, "asset id exceeds uint32");
            assetIds[i] = uint32(rawIds[i]);
        }

        vm.startBroadcast(pk);
        bridge = new MosaicBridge(admin, assetIds, tokens);
        vm.stopBroadcast();

        console2.log("MosaicBridge:", address(bridge));
        console2.log("admin:", admin);
        for (uint256 i = 0; i < assetIds.length; i++) {
            console2.log("registered asset:", assetIds[i], "->", tokens[i]);
        }
    }
}
