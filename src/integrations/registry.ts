import type { Integration } from '../core/types.js';

/**
 * Central registry of all known integrations.
 * In the future this can support dynamic discovery / plugin loading.
 */
export class IntegrationRegistry {
    private integrations = new Map<string, Integration>();

    register(integration: Integration): void {
        if (this.integrations.has(integration.name)) {
            throw new Error(
                `Integration "${integration.name}" is already registered`,
            );
        }
        this.integrations.set(integration.name, integration);
    }

    get(name: string): Integration | undefined {
        return this.integrations.get(name);
    }

    getAll(): Integration[] {
        return Array.from(this.integrations.values());
    }

    has(name: string): boolean {
        return this.integrations.has(name);
    }
}
