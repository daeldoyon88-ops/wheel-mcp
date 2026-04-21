export class MarketDataProvider {
  async getQuote(_symbol) {
    throw new Error("getQuote not implemented");
  }

  async getOptions(_symbol, _params = undefined) {
    throw new Error("getOptions not implemented");
  }

  async getChart(_symbol, _params) {
    throw new Error("getChart not implemented");
  }
}
