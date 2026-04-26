import { Client, Contract, TickType } from "ib-tws-api";
import { BrokerReadOnlyProvider } from "./brokerReadOnlyProvider.js";
import { assertIbkrReadOnly, IBKR_CONFIG } from "../config/ibkr.js";

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseSnapshotValue(snapshot, tickType) {
  if (snapshot == null) return null;
  if (Array.isArray(snapshot)) {
    const match = snapshot.find(
      (entry) =>
        Number(entry?.tickType) === Number(tickType) ||
        Number(entry?.type) === Number(tickType) ||
        Number(entry?.field) === Number(tickType)
    );
    return toFiniteNumber(match?.price ?? match?.value ?? match?.size);
  }
  if (typeof snapshot === "object") {
    return toFiniteNumber(
      snapshot[tickType] ??
        snapshot[String(tickType)] ??
        snapshot?.prices?.[tickType] ??
        snapshot?.prices?.[String(tickType)]
    );
  }
  return null;
}

export class IbkrReadOnlyProvider extends BrokerReadOnlyProvider {
  constructor(config = {}) {
    super();
    assertIbkrReadOnly();
    this.config = { ...IBKR_CONFIG, ...config };
    this.client = new Client({
      host: this.config.host,
      port: this.config.port,
      clientId: this.config.clientId,
      timeoutMs: this.config.connectTimeoutMs,
    });
    this.connected = false;
  }

  async connect() {
    assertIbkrReadOnly();
    if (this.connected) return;
    await this.client.connect();
    this.connected = true;
  }

  async disconnect() {
    if (!this.connected) return;
    if (typeof this.client.disconnect === "function") {
      await this.client.disconnect();
    } else if (typeof this.client.close === "function") {
      this.client.close();
    }
    this.connected = false;
  }

  async getQuote(symbol) {
    assertIbkrReadOnly();
    if (!symbol) throw new Error("symbol is required");
    await this.connect();
    const contract = Contract.stock(String(symbol).trim().toUpperCase());
    const snapshot = await this.client.getMarketDataSnapshot({ contract });
    const bid = parseSnapshotValue(snapshot, TickType.BID);
    const ask = parseSnapshotValue(snapshot, TickType.ASK);
    const last = parseSnapshotValue(snapshot, TickType.LAST);
    const close = parseSnapshotValue(snapshot, TickType.CLOSE);
    const volume = parseSnapshotValue(snapshot, TickType.VOLUME);
    return {
      symbol: String(symbol).trim().toUpperCase(),
      source: "ibkr",
      bid,
      ask,
      last,
      close,
      volume,
      regularMarketPrice: last ?? close ?? bid ?? ask ?? null,
      fetchedAt: new Date().toISOString(),
    };
  }

  async getAccountSnapshot() {
    return { connected: this.connected, source: "ibkr", mode: "read_only" };
  }

  async getOpenPositions() {
    return [];
  }

  async getOptionChains(_symbol) {
    return [];
  }
}
