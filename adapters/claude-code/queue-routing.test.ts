import assert from 'node:assert/strict';
import test from 'node:test';
import { mochatRouteFromMetadata, mochatRouteFromOutgoing } from './queue-routing';

test('MoChat reply route survives the persisted outgoing-queue round trip', () => {
    const route = mochatRouteFromMetadata({
        targetKind: 'panel',
        targetId: 'panel-123',
        groupId: 'group-456',
        sourceMessageId: 'message-789',
    });
    const persisted = JSON.parse(JSON.stringify({ mochatRoute: route }));

    assert.deepEqual(mochatRouteFromOutgoing(persisted), {
        targetKind: 'panel',
        targetId: 'panel-123',
        groupId: 'group-456',
        replyTo: 'message-789',
    });
});

test('invalid route metadata cannot select an outgoing destination', () => {
    assert.equal(mochatRouteFromMetadata({ targetKind: 'unknown', targetId: 'x' }), undefined);
    assert.equal(mochatRouteFromOutgoing({ mochatRoute: { targetKind: 'session' } }), undefined);
});
