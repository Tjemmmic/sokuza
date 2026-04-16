import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CronIntegration } from './index.js';
import type { EventHandler, EventPayload } from '../../core/types.js';

function makeIntegration(): CronIntegration {
    return new CronIntegration();
}

describe('CronIntegration', () => {
    let cron: CronIntegration;
    let events: EventPayload[];

    beforeEach(async () => {
        cron = makeIntegration();
        events = [];
        const handler: EventHandler = async (event) => {
            events.push(event);
        };
        await cron.initialize({});
        cron.registerRoutes({} as any, handler);
    });

    afterEach(() => {
        cron.stopAll();
    });

    it('should have name "cron"', () => {
        expect(cron.name).toBe('cron');
    });

    it('should list supported events', () => {
        expect(cron.supportedEvents).toContain('every-5m');
        expect(cron.supportedEvents).toContain('hourly');
        expect(cron.supportedEvents).toContain('daily');
    });

    it('should throw on parseEvent', () => {
        expect(() => cron.parseEvent({} as any)).toThrow('does not parse HTTP requests');
    });

    describe('startSchedule', () => {
        it('should fire events at the configured interval', () => {
            vi.useFakeTimers();

            cron.startSchedule('every-1m');

            expect(events).toHaveLength(0);

            vi.advanceTimersByTime(60_000);
            expect(events).toHaveLength(1);
            expect(events[0].source).toBe('cron');
            expect(events[0].event).toBe('every-1m');

            vi.advanceTimersByTime(60_000);
            expect(events).toHaveLength(2);

            vi.useRealTimers();
        });

        it('should not start duplicate schedules', () => {
            vi.useFakeTimers();

            cron.startSchedule('every-1m');
            cron.startSchedule('every-1m');

            vi.advanceTimersByTime(60_000);
            expect(events).toHaveLength(1);

            vi.useRealTimers();
        });

        it('should ignore unknown schedules', () => {
            cron.startSchedule('nonexistent-schedule');
            // No timer created, no error thrown
        });

        it('should support custom intervals', () => {
            vi.useFakeTimers();

            cron.startSchedule('every-2m');

            vi.advanceTimersByTime(120_000);
            expect(events).toHaveLength(1);
            expect(events[0].event).toBe('every-2m');

            vi.useRealTimers();
        });
    });

    describe('stopAll', () => {
        it('should stop all running schedules', () => {
            vi.useFakeTimers();

            cron.startSchedule('every-1m');
            cron.startSchedule('every-5m');

            vi.advanceTimersByTime(60_000);
            expect(events).toHaveLength(1);

            cron.stopAll();

            vi.advanceTimersByTime(300_000);
            // No new events after stop
            expect(events).toHaveLength(1);

            vi.useRealTimers();
        });
    });
});
