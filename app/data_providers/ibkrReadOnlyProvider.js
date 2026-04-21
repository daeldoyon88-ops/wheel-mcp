import { BrokerReadOnlyProvider } from "./brokerReadOnlyProvider.js";

// Placeholder adapter for future IBKR integration in read-only mode.
// No order placement methods are exposed here by design.
export class IbkrReadOnlyProvider extends BrokerReadOnlyProvider {
  async getAccountSnapshot() {
    return { connected: false, source: "ibkr", mode: "read_only" };
  }

  async getOpenPositions() {
    return [];
  }

  async getOptionChains(_symbol) {
    return [];
  }
}
