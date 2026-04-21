export class BrokerReadOnlyProvider {
  async getAccountSnapshot() {
    throw new Error("getAccountSnapshot not implemented");
  }

  async getOpenPositions() {
    throw new Error("getOpenPositions not implemented");
  }

  async getOptionChains(_symbol) {
    throw new Error("getOptionChains not implemented");
  }
}
