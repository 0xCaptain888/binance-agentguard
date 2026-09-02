import type { BinanceAgenticGateway, Order, Quote, TradeIntent } from "./core.js";

export type SimulationMode = "verified" | "bad-output";

export class SimulatedBinanceAgenticGateway implements BinanceAgenticGateway {
  readonly name = "binance-agentic-simulator";
  private sequence = 0;
  private readonly orders = new Map<string, Order>();

  constructor(private readonly mode: SimulationMode = "verified") {}

  async getQuote(symbol: string): Promise<Quote> {
    return { symbol, bid: 600, ask: 600.2, observedAt: "2026-09-02T00:00:00.000Z", source: "binance-agentic-simulator" };
  }

  async placeSpotOrder(input: { intent: TradeIntent; quote: Quote }): Promise<Order> {
    const orderId = `SIM-${++this.sequence}`;
    const quoteQty = this.mode === "bad-output" ? input.intent.notionalQuote * 2 : input.intent.notionalQuote;
    const order: Order = {
      orderId,
      symbol: input.intent.symbol,
      side: input.intent.side,
      status: "FILLED",
      executedQty: quoteQty / input.quote.ask,
      quoteQty,
      avgPrice: input.quote.ask,
      clientOrderId: input.intent.taskId,
      executedAt: "2026-09-02T00:00:01.000Z"
    };
    this.orders.set(orderId, order);
    return order;
  }

  async getOrder(_symbol: string, orderId: string): Promise<Order> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`simulated order not found: ${orderId}`);
    return order;
  }
}
