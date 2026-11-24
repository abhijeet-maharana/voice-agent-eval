import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastMention, revealState, words, type Piece } from '../web/src/reveal';

// Drawing while the tutor speaks: boxes show as their labels are heard.

test('reveal: labels match spoken words loosely (plurals, order, filler words)', () => {
  assert.deepEqual(words('Sends Requests to the Queues!'), ['send', 'request', 'to', 'the', 'queue']);
  const heard = words('first the request reaches the load balancer, then the server for the app');
  assert.ok(lastMention(heard, 'Load balancer') > 0);
  assert.ok(lastMention(heard, 'App server') > 0, 'any order within a short window');
  assert.equal(lastMention(heard, 'Database'), -1);
  assert.equal(lastMention(words('the load is high and later a balancer was added far away'), 'Load balancer'), -1, 'words too far apart');
});

test('reveal: nodes as named, edges once both ends show, messages top down, "now" is the latest', () => {
  const flow: Piece[] = [
    { kind: 'node', key: 'A', label: 'Client' },
    { kind: 'node', key: 'B', label: 'Load balancer' },
    { kind: 'node', key: 'C', label: 'App server' },
    { kind: 'edge', from: 'A', to: 'B', label: '' },
    { kind: 'edge', from: 'B', to: 'C', label: 'HTTP call' },
  ];
  let r = revealState(flow, 'It starts at the client.');
  assert.deepEqual([...r.shown], [0]);
  assert.equal(r.now, 0);
  r = revealState(flow, 'It starts at the client. Then the load balancer.');
  assert.deepEqual([...r.shown].sort(), [0, 1, 3]);
  assert.equal(r.now, 1);
  r = revealState(flow, 'The client talks to the load balancer, which makes an HTTP call.');
  assert.deepEqual([...r.shown].sort(), [0, 1, 2, 3, 4], 'a named arrow shows its ends');

  const seq: Piece[] = [
    { kind: 'message', order: 0, label: 'Send request' },
    { kind: 'message', order: 1, label: 'Check cache' },
    { kind: 'message', order: 2, label: 'Return JSON' },
  ];
  assert.deepEqual([...revealState(seq, 'and then we check the cache').shown].sort(), [0, 1]);
  assert.equal(revealState(seq, 'nothing yet').shown.size, 0);
});
