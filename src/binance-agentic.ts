import type { BinanceAgenticGateway as Gateway, Order, Quote, TradeIntent } from "./core.js";

/**
 * Protocol boundary for Binance's Agentic MCP/Agent OS connection.
 * The official endpoint uses an authenticated client flow; credentials are
 * intentionally not stored in this repository. Inject the transport from the
 * user's approved Agent OS session and map its tool names here.
 */
export type AgenticTransport = {
  call<T>(tool: string, input: Record<string, unknown>): Promise<T>;
};

export type AgenticToolMap = {
  quote: string;
  placeSpotOrder: string;
  getOrder: string;
};

export class BinanceAgenticGateway implements Gateway {
  readonly name = "binance-agentic";

  constructor(private readonly transport: AgenticTransport, private readonly tools: AgenticToolMap) {}

  getQuote(symbol: string): Promise<Quote> {
    return this.transport.call<Quote>(this.tools.quote, { symbol });
  }

  placeSpotOrder(input: { intent: TradeIntent; quote: Quote }): Promise<Order> {
    return this.transport.call<Order>(this.tools.placeSpotOrder, {
      symbol: input.intent.symbol,
      side: input.intent.side,
      type: "MARKET",
      quoteOrderQty: input.intent.notionalQuote,
      clientOrderId: input.intent.taskId,
      quote: input.quote
    });
  }

  getOrder(symbol: string, orderId: string): Promise<Order> {
    return this.transport.call<Order>(this.tools.getOrder, { symbol, orderId });
  }
}
