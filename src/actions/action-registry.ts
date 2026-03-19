import type { ActionContext, ActionHandler } from '../core/types.js';

/**
 * Registry mapping action names to their handler functions.
 * Actions are the "verbs" that workflow steps invoke.
 */
export class ActionRegistry {
    private handlers = new Map<string, ActionHandler>();

    register(name: string, handler: ActionHandler): void {
        if (this.handlers.has(name)) {
            throw new Error(`Action "${name}" is already registered`);
        }
        this.handlers.set(name, handler);
    }

    get(name: string): ActionHandler | undefined {
        return this.handlers.get(name);
    }

    getMap(): Map<string, ActionHandler> {
        return new Map(this.handlers);
    }

    has(name: string): boolean {
        return this.handlers.has(name);
    }
}
