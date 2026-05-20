import type { NodeDefinition, SerializedNodeDefinition } from './types.js';
import { serializeNodeDefinition } from './types.js';

/**
 * Process-wide node registry. Built-in node definitions register at startup
 * (see registerBuiltinNodes); integrations may add their own. The dashboard
 * reads the serialized form via GET /api/nodes to populate the palette and
 * inspector forms — no parallel client-side definitions to keep in sync.
 */
export class NodeRegistry {
    private byType = new Map<string, NodeDefinition>();

    register(def: NodeDefinition): void {
        if (this.byType.has(def.type)) {
            throw new Error(`Node type "${def.type}" is already registered`);
        }
        this.byType.set(def.type, def);
    }

    get(type: string): NodeDefinition | undefined {
        return this.byType.get(type);
    }

    has(type: string): boolean {
        return this.byType.has(type);
    }

    list(): NodeDefinition[] {
        return [...this.byType.values()];
    }

    serialize(): SerializedNodeDefinition[] {
        return this.list().map(serializeNodeDefinition);
    }

    clear(): void {
        this.byType.clear();
    }
}

let globalRegistry: NodeRegistry | null = null;

/** Singleton accessor — the engine and the API share one registry. */
export function getNodeRegistry(): NodeRegistry {
    if (!globalRegistry) globalRegistry = new NodeRegistry();
    return globalRegistry;
}

/** For tests: reset the registry between cases. */
export function resetNodeRegistry(): void {
    globalRegistry = new NodeRegistry();
}
