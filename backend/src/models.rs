use serde::{Deserialize, Serialize};

/// A trading desk = one deployed `settlement` contract + its sponsor ("main") account + the
/// assets and pairs registered on it.
#[derive(Clone, Debug, Serialize)]
pub struct Desk {
    pub id: String,
    pub name: String,
    pub contract_id: String,
    /// Sponsor / main account public key (G...). Pays all sponsored fees; admin of the contract.
    pub sponsor_pubkey: String,
    /// First ledger that can contain this desk's initialization events. Browser-side replay starts
    /// here instead of ledger 1, which is outside public RPC retention.
    pub event_start_ledger: Option<u64>,
    pub assets: Vec<Asset>,
    pub pairs: Vec<Pair>,
    pub base_deployment: Option<BaseDeployment>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BaseAssetMapping {
    pub asset_id: u32,
    pub symbol: String,
    pub token: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BaseDeployment {
    pub status: String,
    pub deployer_address: String,
    pub tx_hash: Option<String>,
    pub bridge_address: Option<String>,
    pub error: Option<String>,
    pub assets: Vec<BaseAssetMapping>,
}

/// What an asset *is*, mirroring the contract's `AssetKind`. The serde names match the on-chain enum
/// variants exactly so the desk's `assets` array can be serialized straight into the constructor's
/// JSON argument. Fixes which deposit routes the asset may use (see docs/architecture.md):
///   - `Stellar`         = distributed on Stellar (real SAC). shield ✓, bridge ✗.
///   - `Dual`            = distributed on both chains. shield ✓, bridge ✓.
///   - `BaseRepresented` = distributed on Base, only represented on Stellar (no real token).
///                         bridge ✓, shield ✗, unshield ✗ (trade-only).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AssetKind {
    Stellar,
    Dual,
    BaseRepresented,
}

fn default_asset_kind() -> AssetKind {
    AssetKind::Stellar
}

/// MosaicBridge sentinel marking an asset whose Base side is native ETH (deposited via
/// `shieldNative`). Must match `NATIVE` in `evm/src/MosaicBridge.sol`.
pub const NATIVE_EVM_SENTINEL: &str = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

impl AssetKind {
    /// Stable name used for DB storage and the contract's constructor JSON (matches the on-chain
    /// enum variant names exactly).
    pub fn as_str(&self) -> &'static str {
        match self {
            AssetKind::Stellar => "Stellar",
            AssetKind::Dual => "Dual",
            AssetKind::BaseRepresented => "BaseRepresented",
        }
    }

    /// Parse a stored/legacy value; anything unrecognized falls back to `Stellar`.
    pub fn from_db(s: &str) -> Self {
        match s {
            "Dual" => AssetKind::Dual,
            "BaseRepresented" => AssetKind::BaseRepresented,
            _ => AssetKind::Stellar,
        }
    }

    /// True when this asset can be deposited via the Stellar `shield` route (has a real token).
    pub fn is_stellar_shieldable(&self) -> bool {
        matches!(self, AssetKind::Stellar | AssetKind::Dual)
    }
}

/// A supported currency on a desk: protocol `asset_id` -> Soroban token contract address.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Asset {
    pub asset_id: u32,
    pub symbol: String,
    pub token: String,
    /// Decimals for display (XLM/USDC SACs use 7).
    #[serde(default = "default_decimals")]
    pub decimals: u32,
    /// Asset class fixing the legal deposit routes. Defaults to `Stellar` for legacy rows.
    #[serde(default = "default_asset_kind")]
    pub kind: AssetKind,
}

fn default_decimals() -> u32 {
    7
}

/// An entry in the app-wide asset catalog: a cross-chain asset definition linking a Stellar side
/// (always present) to an optional Base side. This is off-chain metadata; actual on-chain support
/// is still configured at contract deployment on both chains.
#[derive(Clone, Debug, Serialize)]
pub struct CatalogAsset {
    pub id: String,
    pub symbol: String,
    /// Stellar token: `"native"` (XLM), `"CODE:ISSUER"`, or a `C...` contract id. `None` if the
    /// asset is not on Stellar.
    pub stellar_token: Option<String>,
    pub stellar_decimals: Option<u32>,
    /// Base chain id (e.g. 84532 for Base Sepolia); `None` if the asset is not on Base.
    pub base_chain_id: Option<i64>,
    /// Base token: `"native"` (ETH) or an ERC20 address (`0x...`); `None` if not on Base.
    pub base_token: Option<String>,
    pub base_decimals: Option<u32>,
    /// The G... wallet that proposed this asset; `None` for built-in defaults.
    pub proposer_address: Option<String>,
    pub is_default: bool,
    pub created_at: i64,
}

/// A canonical trading pair registered on the desk. `pair_id` is assigned by the contract,
/// sequentially from 0, in registration order.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Pair {
    pub pair_id: u32,
    pub base_asset: u32,
    pub quote_asset: u32,
}

/// Body for creating a new desk (deploys a fresh contract). Phase 2.
#[derive(Clone, Debug, Deserialize)]
pub struct CreateDesk {
    pub name: String,
    pub assets: Vec<CreateDeskAsset>,
    /// Pairs as (base_asset, quote_asset); `pair_id` is assigned by the contract on register.
    pub pairs: Vec<NewPair>,
    pub base_deployment: Option<CreateBaseDeployment>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CreateDeskAsset {
    pub catalog_id: String,
    pub asset_id: u32,
    pub symbol: String,
    /// Stellar token: a SAC id / `"native"` / `"CODE:ISSUER"` for `Stellar`/`Dual`; ignored (and
    /// `None` on-chain) for `BaseRepresented`.
    pub token: String,
    #[serde(default = "default_decimals")]
    pub decimals: u32,
    #[serde(default = "default_asset_kind")]
    pub kind: AssetKind,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CreateBaseDeployment {
    pub deployer_address: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct NewPair {
    pub base_asset: u32,
    pub quote_asset: u32,
}

/// Body for importing an already-deployed contract as a desk (Phase 1 convenience / read-only).
#[derive(Clone, Debug, Deserialize)]
pub struct ImportDesk {
    pub name: String,
    pub contract_id: String,
    pub sponsor_pubkey: String,
    pub assets: Vec<Asset>,
    pub pairs: Vec<Pair>,
}
