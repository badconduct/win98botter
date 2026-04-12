"use strict";

/**
 * Heartbeat tracker and watchdog timer.
 *
 * - Tracks the last heartbeat received from Win98
 * - Fires alert webhooks when heartbeat is missing
 * - Runs scheduled health checks from healthchecks.json (cron format)
 */

const fs = require("fs");
const http = require("https"); // for webhook POSTs

let cron;
try {
  cron = require("node-cron");
} catch (_) {
  cron = null;
}

class Watchdog {
  constructor(win98Client, agentLoopFactory, logger, config) {
    this.win98 = win98Client;
    this.makeLoop = agentLoopFactory;
    this.log = logger;
    this.config = config || {};

    this._watchdogInterval = null;
    this._cronJobs = [];
    this._alertedSessions = new Set();
  }

  /**
   * Start the watchdog and load scheduled health checks.
   */
  start() {
    const intervalMs = (this.config.watchdogIntervalSec || 30) * 1000;

    this._watchdogInterval = setInterval(() => this._tick(), intervalMs);

    if (this.config.healthchecksPath) {
      this._loadHealthChecks(this.config.healthchecksPath);
    }

    this.log.info(
      { intervalSec: this.config.watchdogIntervalSec || 30 },
      "Watchdog started",
    );
  }

  stop() {
    if (this._watchdogInterval) {
      clearInterval(this._watchdogInterval);
      this._watchdogInterval = null;
    }
    for (const job of this._cronJobs) {
      try {
        job.stop();
      } catch (_) {
        /* ignore */
      }
    }
    this._cronJobs = [];
  }

  _tick() {
    const status = this.win98.getStatus();
    if (!status.connected) return;

    const lastHb = this.win98.lastHeartbeat;
    const timeoutMs = (this.config.heartbeatTimeoutSec || 300) * 1000;
    const warnMs = (this.config.heartbeatTimeoutSec || 300) * 1000 * 0.3; // ~90s warning at default

    if (!lastHb) return; // No heartbeat received yet

    const silentMs = Date.now() - lastHb;

    if (silentMs >= timeoutMs) {
      const sessionKey = `disconnected_${status.host}`;
      if (!this._alertedSessions.has(sessionKey)) {
        this._alertedSessions.add(sessionKey);
        this._fireAlert("disconnected_presumed", {
          win98_host: status.host,
          last_seen: new Date(lastHb).toISOString(),
          minutes_silent: Math.round(silentMs / 60000),
        });
      }
    } else if (silentMs >= warnMs) {
      const sessionKey = `missed_${status.host}`;
      if (!this._alertedSessions.has(sessionKey)) {
        this._alertedSessions.add(sessionKey);
        this._fireAlert("heartbeat_missed", {
          win98_host: status.host,
          last_seen: new Date(lastHb).toISOString(),
          minutes_silent: Math.round(silentMs / 60000),
        });
      }
    } else {
      // Clear alert state when heartbeat is current again
      this._alertedSessions.delete(`missed_${status.host}`);
      this._alertedSessions.delete(`disconnected_${status.host}`);
    }
  }

  _loadHealthChecks(filePath) {
    if (!cron) {
      this.log.warn(
        "node-cron not installed — healthchecks.json will not be scheduled",
      );
      return;
    }

    if (!fs.existsSync(filePath)) return;

    let checks;
    try {
      checks = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      this.log.error({ err }, "Failed to parse healthchecks.json");
      return;
    }

    for (const check of checks || []) {
      if (!check.schedule || !check.message || !check.session_id) continue;

      const job = cron.schedule(check.schedule, async () => {
        this.log.info({ check: check.name }, "Running scheduled health check");
        try {
          const loop = this.makeLoop();
          const result = await loop.run(check.session_id, check.message, 80000);
          this.log.info(
            { check: check.name, response: result.response.slice(0, 200) },
            "Health check complete",
          );
          // If response contains problem indicators, fire alert
          if (
            /error|fail|problem|issue|crash|not running/i.test(result.response)
          ) {
            this._fireAlert("health_check_issue", {
              check_name: check.name,
              summary: result.response.slice(0, 500),
            });
          }
        } catch (err) {
          this.log.error({ err, check: check.name }, "Health check failed");
        }
      });

      this._cronJobs.push(job);
      this.log.info(
        { name: check.name, schedule: check.schedule },
        "Scheduled health check registered",
      );
    }
  }

  async _fireAlert(event, params) {
    const webhookUrl = this.config.alertWebhookUrl;
    if (!webhookUrl) return;

    const payload = JSON.stringify({
      event,
      ...params,
      timestamp: new Date().toISOString(),
    });
    this.log.info({ event }, "Firing alert webhook");

    try {
      // Simple HTTP POST — works for Slack, Discord, n8n
      const url = new URL(webhookUrl);
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      };

      const mod =
        url.protocol === "https:" ? require("https") : require("http");
      const req = mod.request(options);
      req.on("error", (err) =>
        this.log.warn({ err }, "Alert webhook request failed"),
      );
      req.write(payload);
      req.end();
    } catch (err) {
      this.log.warn({ err }, "Failed to fire alert webhook");
    }
  }
}

module.exports = Watchdog;
