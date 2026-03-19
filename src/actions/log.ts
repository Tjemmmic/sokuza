import type { ActionHandler } from '../core/types.js';

/**
 * Built-in "log" action — logs a message with event context.
 */
export const logAction: ActionHandler = async (params, context) => {
    const message = (params.message as string) ?? 'No message provided';
    const level = (params.level as string) ?? 'info';

    const logData = {
        action: 'log',
        source: context.event.source,
        event: context.event.event,
    };

    switch (level) {
        case 'warn':
            context.logger.warn(logData, message);
            break;
        case 'error':
            context.logger.error(logData, message);
            break;
        case 'debug':
            context.logger.debug(logData, message);
            break;
        default:
            context.logger.info(logData, message);
    }

    return { logged: true, message };
};
