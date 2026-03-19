import type {
    FastifyInstance,
    FastifyRequest,
} from 'fastify';
import type {
    EventHandler,
    EventPayload,
    Integration,
    IntegrationConfig,
} from '../../core/types.js';

interface CronJob {
    name: string;
    schedule: string;
    timer?: ReturnType<typeof setInterval>;
}

/**
 * Cron integration — time-based triggers.
 *
 * Uses a simple interval-based scheduler (no external dependencies).
 * Supports standard cron-like schedules parsed into intervals.
 *
 * Config:
 * ```yaml
 * integrations:
 *   cron: {}
 * ```
 *
 * Trigger:
 * ```yaml
 * trigger:
 *   source: cron
 *   event: every-5m    # or: daily, hourly, every-15m, every-30m, every-1h
 * ```
 *
 * Built-in schedules:
 *   - every-1m, every-5m, every-15m, every-30m
 *   - hourly, daily
 *   - Custom interval: every-{N}m or every-{N}h
 */
export class CronIntegration implements Integration {
    readonly name = 'cron';
    readonly supportedEvents = [
        'every-1m',
        'every-5m',
        'every-15m',
        'every-30m',
        'hourly',
        'daily',
    ];

    private jobs: CronJob[] = [];
    private onEvent: EventHandler | null = null;

    async initialize(_config: IntegrationConfig): Promise<void> {
        // No config needed — schedules come from workflow triggers
    }

    parseEvent(_request: FastifyRequest): EventPayload {
        // Cron events are generated internally, not from HTTP requests
        throw new Error('CronIntegration does not parse HTTP requests');
    }

    registerRoutes(_server: FastifyInstance, onEvent: EventHandler): void {
        // Cron doesn't register HTTP routes — it uses timers
        this.onEvent = onEvent;
    }

    /**
     * Start a cron schedule. Called by the engine after workflow analysis.
     */
    startSchedule(eventName: string): void {
        if (!this.onEvent) return;
        if (this.jobs.some((j) => j.name === eventName)) return; // already running

        const intervalMs = parseScheduleToMs(eventName);
        if (!intervalMs) return;

        const handler = this.onEvent;
        const timer = setInterval(() => {
            const event: EventPayload = {
                source: 'cron',
                event: eventName,
                timestamp: new Date().toISOString(),
                payload: {
                    schedule: eventName,
                    firedAt: new Date().toISOString(),
                },
                metadata: {
                    schedule: eventName,
                },
            };
            handler(event).catch(() => { });
        }, intervalMs);

        this.jobs.push({ name: eventName, schedule: eventName, timer });
    }

    /**
     * Stop all cron jobs.
     */
    stopAll(): void {
        for (const job of this.jobs) {
            if (job.timer) clearInterval(job.timer);
        }
        this.jobs = [];
    }
}

/**
 * Parse a schedule name into a millisecond interval.
 */
function parseScheduleToMs(schedule: string): number | null {
    const aliases: Record<string, number> = {
        'every-1m': 60_000,
        'every-5m': 5 * 60_000,
        'every-15m': 15 * 60_000,
        'every-30m': 30 * 60_000,
        'hourly': 60 * 60_000,
        'daily': 24 * 60 * 60_000,
    };

    if (aliases[schedule]) return aliases[schedule];

    // Parse custom: every-{N}m or every-{N}h
    const match = schedule.match(/^every-(\d+)(m|h)$/);
    if (match) {
        const n = parseInt(match[1], 10);
        const unit = match[2] === 'h' ? 60 * 60_000 : 60_000;
        return n * unit;
    }

    return null;
}
