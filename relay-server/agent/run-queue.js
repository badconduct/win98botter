"use strict";

class AgentRunQueue {
  constructor() {
    this._tails = new Map();
  }

  async run(agentId, task) {
    const key = String(agentId || "default");
    const previous = this._tails.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this._tails.set(key, current);

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this._tails.get(key) === current) this._tails.delete(key);
    }
  }
}

module.exports = AgentRunQueue;
