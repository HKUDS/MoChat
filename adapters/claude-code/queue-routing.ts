export type MochatReplyRoute = {
    targetKind: 'session' | 'panel';
    targetId: string;
    groupId: string | null;
    replyTo: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function normalizeRoute(value: unknown): MochatReplyRoute | undefined {
    const route = asRecord(value);
    const targetKind = route?.targetKind;
    const targetId = route?.targetId;
    if (
        (targetKind !== 'session' && targetKind !== 'panel') ||
        typeof targetId !== 'string' ||
        !targetId.trim()
    ) {
        return undefined;
    }

    return {
        targetKind,
        targetId,
        groupId: typeof route.groupId === 'string' && route.groupId ? route.groupId : null,
        replyTo: typeof route.replyTo === 'string' && route.replyTo ? route.replyTo : null,
    };
}

export function mochatRouteFromMetadata(metadata: unknown): MochatReplyRoute | undefined {
    const source = asRecord(metadata);
    if (!source) {
        return undefined;
    }
    return normalizeRoute({
        targetKind: source.targetKind,
        targetId: source.targetId,
        groupId: source.groupId,
        replyTo: source.sourceMessageId,
    });
}

export function mochatRouteFromOutgoing(value: unknown): MochatReplyRoute | undefined {
    return normalizeRoute(asRecord(value)?.mochatRoute);
}
