import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../src/core/emitter';
import { ChatService, MAX_CHAT_LENGTH, normalize } from '../../src/services/ChatService';
import type { SignalingStatus } from '../../src/services/SignalingService';
import type { SignalingMessage } from '../../src/types/signaling';

function world() {
  const events = new Emitter<{ status: SignalingStatus; message: { msg: SignalingMessage; room: string }; reconnected: void; echo: { msg: SignalingMessage; room: string } }>();
  const sent: Array<{ room: string; payload: unknown; messageId: string }> = [];
  let seq = 0;
  const transport = {
    events,
    status: 'connected' as SignalingStatus,
    broadcast(room: string, _type: string, payload: unknown, opts: { messageId?: string } = {}) {
      const messageId = opts.messageId ?? `own-${++seq}`;
      sent.push({ room, payload, messageId });
      return messageId;
    },
  };
  const chat = new ChatService(transport as never, { deviceId: 'me', displayName: 'Me' });
  chat.start();
  const remote = (id: string, text: string, ts: number, callId = 'call-1', sender = 'john'): void =>
    events.emit('message', {
      room: 'mesh-call-1',
      msg: {
        v: 2, messageType: 'chat-message', messageId: id, timestamp: ts, senderId: sender, senderSessionId: 's', senderName: sender === 'john' ? 'John' : 'Sarah',
        receiverId: '*', roomId: 'r', callId, peerId: 's', payload: { text },
      } as SignalingMessage,
    });
  const echo = (messageId: string) => events.emit('echo', { room: 'mesh-call-1', msg: { messageType: 'chat-message', messageId } as SignalingMessage });
  return { chat, transport, sent, remote, echo, events };
}

describe('ChatService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends over the call mesh room and shows the message immediately as own/sending', () => {
    const { chat, sent } = world();
    chat.bind('call-1');
    expect(chat.send('  Hello everyone!  ')).toBe('sent');
    expect(sent[0]).toMatchObject({ room: 'mesh-call-1', payload: { text: 'Hello everyone!' } });
    expect(chat.messages[0]).toMatchObject({ own: true, delivery: 'sending', text: 'Hello everyone!', callId: 'call-1' });
    expect(chat.status).toBe('sending');
  });

  it('marks own messages sent on ScaleDrone echo', () => {
    const { chat, sent, echo } = world();
    chat.bind('call-1');
    chat.send('hi');
    echo(sent[0]!.messageId);
    expect(chat.messages[0]!.delivery).toBe('sent');
    expect(chat.status).toBe('connected');
  });

  it('rejects empty / whitespace / too-long messages and accidental double sends', () => {
    const { chat, sent } = world();
    chat.bind('call-1');
    expect(chat.send('')).toBe('empty');
    expect(chat.send('   \n\n ')).toBe('empty');
    expect(chat.send('x'.repeat(MAX_CHAT_LENGTH + 1))).toBe('too-long');
    expect(chat.send('same')).toBe('sent');
    expect(chat.send('same')).toBe('duplicate');
    vi.advanceTimersByTime(1000);
    expect(chat.send('same')).toBe('sent'); // deliberate repeat later is fine
    expect(sent).toHaveLength(2);
  });

  it('keeps multi-line text (Shift+Enter) but trims and collapses excessive blank lines', () => {
    expect(normalize('  line 1\r\nline 2\n\n\n\nline 3  ')).toBe('line 1\nline 2\n\nline 3');
  });

  it('does not send while signaling is unavailable', () => {
    const { chat, transport, sent } = world();
    chat.bind('call-1');
    transport.status = 'reconnecting';
    expect(chat.canSend).toBe(false);
    expect(chat.status).toBe('connecting');
    expect(chat.send('hello')).toBe('unavailable');
    transport.status = 'unavailable';
    expect(chat.status).toBe('disconnected');
    expect(sent).toHaveLength(0);
  });

  it('orders out-of-order messages by timestamp and drops duplicates', () => {
    const { chat, remote } = world();
    chat.bind('call-1');
    remote('m3', 'third', 3000);
    remote('m1', 'first', 1000);
    remote('m2', 'second', 2000);
    remote('m1', 'first', 1000); // duplicate
    expect(chat.messages.map((m) => m.text)).toEqual(['first', 'second', 'third']);
  });

  it('isolates calls: messages for another call never appear', () => {
    const { chat, remote } = world();
    chat.bind('call-1');
    remote('x1', 'other call', 1000, 'call-2');
    remote('x2', 'no call', 1000, null as unknown as string);
    expect(chat.messages).toHaveLength(0);
  });

  it('ignores messages before binding and clears everything on unbind / new call', () => {
    const { chat, remote } = world();
    remote('early', 'too early', 1);
    chat.bind('call-1');
    expect(chat.messages).toHaveLength(0);
    remote('a', 'hello', 1);
    expect(chat.unread).toBe(1);
    chat.unbind();
    expect(chat.messages).toHaveLength(0);
    expect(chat.unread).toBe(0);
    chat.bind('call-1'); // same id again after the call ended = fresh state
    remote('a', 'hello', 1); // processed ids were cleared too
    expect(chat.messages).toHaveLength(1);
  });

  it('counts unread only while the panel is closed and never for own messages', () => {
    const { chat, remote } = world();
    chat.bind('call-1');
    chat.send('mine');
    expect(chat.unread).toBe(0);
    remote('a', 'one', 1);
    remote('b', 'two', 2, 'call-1', 'sarah');
    expect(chat.unread).toBe(2);
    chat.setPanelOpen(true);
    expect(chat.unread).toBe(0);
    remote('c', 'three', 3);
    expect(chat.unread).toBe(0);
  });

  it('marks unconfirmed messages failed and retries with the SAME messageId', () => {
    const { chat, sent, echo } = world();
    chat.bind('call-1');
    chat.send('are you there?');
    vi.advanceTimersByTime(13_000);
    expect(chat.messages[0]!.delivery).toBe('failed');
    expect(chat.status).toBe('error');
    expect(chat.retry(sent[0]!.messageId)).toBe(true);
    expect(sent[1]!.messageId).toBe(sent[0]!.messageId);
    echo(sent[0]!.messageId);
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]!.delivery).toBe('sent');
  });

  it('truncates oversized incoming text and ignores malformed payloads', () => {
    const { chat, events } = world();
    chat.bind('call-1');
    const base = { v: 2, messageType: 'chat-message', timestamp: 1, senderId: 'john', senderSessionId: 's', senderName: 'John', receiverId: '*', roomId: 'r', callId: 'call-1', peerId: 's' };
    events.emit('message', { room: 'r', msg: { ...base, messageId: 'big', payload: { text: 'y'.repeat(10_000) } } as SignalingMessage });
    events.emit('message', { room: 'r', msg: { ...base, messageId: 'bad', payload: { text: 42 } } as unknown as SignalingMessage });
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]!.text.length).toBe(4000);
  });
});
