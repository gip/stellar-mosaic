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
    pub assets: Vec<Asset>,
    pub pairs: Vec<Pair>,
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
}

fn default_decimals() -> u32 {
    7
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
    pub assets: Vec<Asset>,
    /// Pairs as (base_asset, quote_asset); `pair_id` is assigned by the contract on register.
    pub pairs: Vec<NewPair>,
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
