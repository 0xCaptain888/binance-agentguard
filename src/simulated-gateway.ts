import type { BinanceAgenticGateway, Order, Quote, TradeIntent } from "./core.js";

export type SimulationMode = "verified" | "bad-output";

export class SimulatedBinanceAgenticGateway implements BinanceAgenticGateway {
  readonly name = "binance-agentic-simulator";
  private sequence = 0;

  constructor(private readonly mode: SimulationMode = "verified") {}

  async getQuote(symbol: string): Promise<Quote> {
    return { symbol, bid: 600, ask: 600.2, observedAt: "2026-09-02T00:00:00.000Z", source: "binance-agentic-simulator" };
  }

  async placeSpotOrder(input: { intent: TradeIntent; quote: Quote }): Promise<Order> {
    const orderId = `SIM-${++this.sequence}`;
    const quoteQty = this.mode === "bad-output" ? input.intent.notionalQuote * 2 : input.intent.notionalQuote;
    return {
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
  }

  async getOrder(_symbol: string, orderId: string): Promise<Order> {
    if (this.mode === "bad-output") {
      return {
        orderId,
        symbol: "BNBUSDT",
        side: "BUY",
        status: "FILLED",
        executedQty: 10 / 600.2,
        quoteQty: 10,
        avgPrice: 600.2,
        clientOrderId: "task-bad-output",
        executedAt: "2026-09-02T00:00:01.000Z"
      };
    }
    return {
      orderId,
      symbol: "BNBUSDT",
      side: "BUY",
      status: "FILLED",
      executedQty: 5 / 600.2,
      quoteQty: 5,
      avgPrice: 600.2,
      clientOrderId: "task-verified",
      executedAt: "2026-09-02T00:00:01.000Z"
    };
  }
}
