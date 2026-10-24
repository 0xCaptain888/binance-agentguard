import { randomBytes } from "node:crypto";
import { getAddress, verifyMessage, type Address, type Hex } from "viem";

export class WalletSessions {
  private challenges = new Map<string, { address: Address; message: string; expires: number }>();
  private sessions = new Map<string, { address: Address; expires: number }>();
  constructor(private origin: string, private vault: Address, private allowed: Address[], private clock = Date.now) {}
  challenge(address: Address) {
    const now = this.clock();
    for (const [key, value] of this.challenges) if (value.expires <= now) this.challenges.delete(key);
    if (this.challenges.size >= 100) throw new Error("Too many outstanding challenges");
    const normalized = getAddress(address);
    if (!this.allowed.some(a => a.toLowerCase() === normalized.toLowerCase())) throw new Error("Wallet is not owner or operator");
    const nonce = randomBytes(24).toString("hex"), expires = now + 120000;
    const message = `AgentGuard BSC session\nOrigin: ${this.origin}\nChain: 97\nVault: ${this.vault}\nWallet: ${normalized}\nNonce: ${nonce}\nExpires: ${new Date(expires).toISOString()}\nPermission: create plans and verify transactions. No token approval or transfer.`;
    this.challenges.set(nonce, { address: normalized, message, expires });
    return { nonce, message, expires };
  }
  async exchange(nonce: string, signature: Hex) {
    const item = this.challenges.get(nonce); this.challenges.delete(nonce);
    if (!item || item.expires <= this.clock()) throw new Error("Challenge expired or already used");
    if (!await verifyMessage({ address: item.address, message: item.message, signature })) throw new Error("Invalid wallet signature");
    for (const [key, value] of this.sessions) if (value.expires <= this.clock()) this.sessions.delete(key);
    if (this.sessions.size >= 100) throw new Error("Too many sessions");
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, { address: item.address, expires: this.clock() + 900000 });
    return { token, expires: this.clock() + 900000 };
  }
  address(token: string): Address {
    const item = this.sessions.get(token);
    if (!item || item.expires <= this.clock()) { this.sessions.delete(token); throw new Error("Wallet session required"); }
    return item.address;
  }
  revoke(token: string) { this.sessions.delete(token); }
}
