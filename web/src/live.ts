// The live voice in the browser: a Gemini Live session opened straight from the page with the short-lived
// token the server minted (POST /api/sessions), the microphone (16 kHz PCM up) and the interviewer's voice
// (24 kHz PCM down), both through AudioWorklets. Tool calls go to the page, which runs them on the server
// and shows each one.

export type LiveState = 'connecting' | 'listening' | 'speaking' | 'reconnecting' | 'closed';

/** Button mode only: whose turn it is. `waiting`: you pressed Done and the voice has not answered yet. */
export type Turn = 'theirs' | 'yours' | 'waiting';

export interface FunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LiveHandlers {
  onState(state: LiveState): void;
  /** A piece of what was said, as it is recognised. */
  onTranscript(who: 'interviewer' | 'candidate', text: string): void;
  /** Runs the calls and returns one response object per call, in order. */
  onToolCalls(calls: FunctionCall[]): Promise<Record<string, unknown>[]>;
  onTurnComplete(): void;
  /** Microphone loudness 0..1, for the level meter. */
  onLevel(level: number): void;
  /** The session ended for good; `reason` is unset when we closed it. */
  onClose(reason?: string): void;
  /** A connection event for the page's log (also saved with the session, for debugging). */
  onLog(event: string, detail?: string): void;
  /** Button mode: the turn changed. */
  onTurn?(turn: Turn): void;
  /**
   * A piece of the interviewer's transcript at about the moment its audio plays. The transcript arrives
   * ahead of the voice (audio comes faster than real time and waits in the player), so this is what syncs
   * the screen to the voice, e.g. a diagram box appearing as its name is said. Never fires for speech that
   * was cut off.
   */
  onSpoken?(text: string): void;
}

// Mic: resamples to 16 kHz Int16 and posts 100 ms chunks with their loudness.
const MIC_WORKLET =
  'class Mic extends AudioWorkletProcessor{constructor(){super();this.step=sampleRate/16000;this.t=0;this.prev=0;this.buf=new Int16Array(1600);this.n=0;this.sq=0}' +
  'process(inputs){const x=inputs[0][0];if(!x)return true;for(let k=0;k<x.length;k++){const s=x[k];while(this.t<=1){const v=Math.max(-1,Math.min(1,this.prev+(s-this.prev)*this.t));' +
  'this.buf[this.n++]=v*32767;this.sq+=v*v;if(this.n===this.buf.length){this.port.postMessage({pcm:this.buf.buffer,rms:Math.sqrt(this.sq/this.n)},[this.buf.buffer]);this.buf=new Int16Array(1600);this.n=0;this.sq=0}' +
  'this.t+=this.step}this.t-=1;this.prev=s}return true}}registerProcessor("mic",Mic)';
// Player: plays queued Int16 chunks; "flush" drops them; posts true/false when playback starts and stops.
const PLAYER_WORKLET =
  'class Player extends AudioWorkletProcessor{constructor(){super();this.q=[];this.off=0;this.on=false;this.port.onmessage=(e)=>{if(e.data==="flush"){this.q=[];this.off=0}else this.q.push(e.data)}}' +
  'process(_,outputs){const out=outputs[0][0];let i=0;while(i<out.length&&this.q.length){const b=this.q[0];const n=Math.min(out.length-i,b.length-this.off);' +
  'for(let k=0;k<n;k++)out[i+k]=b[this.off+k]/32768;i+=n;this.off+=n;if(this.off>=b.length){this.q.shift();this.off=0}}for(;i<out.length;i++)out[i]=0;' +
  'const on=this.q.length>0;if(on!==this.on){this.on=on;this.port.postMessage(on)}return true}}registerProcessor("player",Player)';
const moduleUrl = (code: string) => URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));

/** While the interviewer speaks, only clearly louder sound goes up, so its own voice in the mic doesn't cut it off. */
const BARGE_IN_RMS = 0.04;
const MAX_RESUMES = 5;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(data: string): Int16Array {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}

export class LiveInterview {
  private ws?: WebSocket;
  private handle?: string;
  private resumes = 0;
  private closed = false;
  private ready = false;
  private micStream?: MediaStream;
  private micCtx?: AudioContext;
  private micNode?: AudioWorkletNode;
  private outCtx?: AudioContext;
  private player?: AudioWorkletNode;
  playing = false;
  muted = false;
  paused = false;
  /**
   * `auto`: Gemini notices when you stop talking. `button`: its voice activity detection is off (set in the
   * server's setup), and the page opens your turn after each reply and closes it when you press Done.
   */
  turnMode: 'auto' | 'button' = 'auto';
  private turnOpen = false;
  /** Extended thinking: a filler ended while a background tool still runs; the real end of turn is still to come. */
  private fillerPending = false;
  /** Audio chunks received in the current model turn, and what was logged once already. */
  private turnAudio = 0;
  private totalAudio = 0;
  /** Heartbeat counters: tells a frozen page (no heartbeats) from a silent Gemini (heartbeats, 0 new messages). */
  private msgs = 0;
  private lastMsgAt = 0;
  private micSent = 0;
  /** Loudest mic chunk since the last heartbeat (0..1); near 0 means the browser is getting silence. */
  private micPeak = 0;
  private beat?: ReturnType<typeof setInterval>;
  private micInfo = 'no mic track';
  private beats = 0;
  private seen = new Set<string>();
  /** When (on the speaker's clock) the queued audio ends, and transcript pieces waiting for their audio to play. */
  private queuedEnd = 0;
  private spoken: { at: number; text: string }[] = [];
  private spokenTimer?: ReturnType<typeof setInterval>;
  /** Drops queued audio and the transcript pieces that went with it (they will never be heard). */
  private flushPlayer() {
    this.player?.port.postMessage('flush');
    this.queuedEnd = this.outCtx?.currentTime ?? 0;
    this.spoken = [];
  }
  /** Hands transcript pieces to onSpoken once the speaker clock reaches their audio (pausing freezes that clock). */
  private queueSpoken(text: string) {
    const ctx = this.outCtx;
    if (!this.h?.onSpoken || !ctx) return;
    this.spoken.push({ at: Math.max(ctx.currentTime, this.queuedEnd), text });
    this.spokenTimer ??= setInterval(() => {
      const now = this.outCtx?.currentTime ?? Infinity;
      while (this.spoken.length && this.spoken[0].at <= now + 0.05) this.h?.onSpoken?.(this.spoken.shift()!.text);
    }, 100);
  }
  private log(event: string, detail?: string) {
    this.h?.onLog(event, detail);
  }
  private once(key: string, event: string, detail?: string) {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.log(event, detail);
  }
  private wsUrl = '';
  private token = '';
  private setup: { setup: Record<string, unknown> } = { setup: {} };
  private h?: LiveHandlers;

  /**
   * Step 1, called first thing in the Start click: speaker and microphone. Browsers (Safari above all)
   * allow audio only while the click still counts, so this runs before any network call.
   */
  async prepareAudio(): Promise<void> {
    if (!window.isSecureContext || !navigator.mediaDevices) throw new Error('The microphone only works on localhost or HTTPS. Open the page on http://localhost.');
    this.outCtx = new AudioContext({ sampleRate: 24000 });
    this.micCtx = new AudioContext();
    const resumed = Promise.all([this.outCtx.resume(), this.micCtx.resume()]);
    const stream = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    await this.outCtx.audioWorklet.addModule(moduleUrl(PLAYER_WORKLET));
    this.player = new AudioWorkletNode(this.outCtx, 'player', { numberOfInputs: 0, outputChannelCount: [1] });
    this.player.port.onmessage = (e) => {
      this.playing = e.data;
      this.log(e.data ? 'playback started' : 'playback stopped', `speaker ${this.outCtx?.state}`);
      if (this.ready) this.h?.onState(this.playing ? 'speaking' : 'listening');
    };
    this.player.connect(this.outCtx.destination);
    this.micStream = await stream;
    const track = this.micStream.getAudioTracks()[0];
    if (track) {
      const st = track.getSettings();
      this.micInfo = `${track.label || 'unnamed mic'} (${track.readyState}${track.muted ? ', MUTED by the system' : ''}${track.enabled ? '' : ', disabled'}, ${st.sampleRate ?? '?'} Hz)`;
      track.onmute = () => this.log('mic muted by the system', 'macOS or Chrome stopped sending sound from this mic');
      track.onunmute = () => this.log('mic unmuted');
      track.onended = () => this.log('mic ended', 'the device was unplugged or the permission was revoked');
    }
    await this.micCtx.audioWorklet.addModule(moduleUrl(MIC_WORKLET));
    await resumed;
    const source = this.micCtx.createMediaStreamSource(this.micStream);
    this.micNode = new AudioWorkletNode(this.micCtx, 'mic');
    this.micNode.port.onmessage = (e) => {
      this.h?.onLevel(e.data.rms);
      if (e.data.rms > this.micPeak) this.micPeak = e.data.rms;
      if (this.muted || this.paused || !this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
      if (this.turnMode === 'button') {
        // Only inside your turn, and not while its voice plays (the speaker would leak into your answer).
        if (!this.turnOpen || this.playing) return;
      } else if (this.playing && e.data.rms < BARGE_IN_RMS) return;
      this.micSent++;
      this.send({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: toBase64(e.data.pcm) } } });
    };
    const sink = this.micCtx.createGain();
    sink.gain.value = 0;
    source.connect(this.micNode).connect(sink).connect(this.micCtx.destination);
  }

  /** Step 2, with the server's session: connect to Gemini Live and let the interviewer open. */
  async connect(wsUrl: string, token: string, setup: { setup: Record<string, unknown> }, handlers: LiveHandlers, kickoff = '(The candidate has joined the call. Start the interview now.)'): Promise<void> {
    this.wsUrl = wsUrl;
    this.token = token;
    this.setup = setup;
    this.h = handlers;
    handlers.onState('connecting');
    const started = performance.now();
    this.beat = setInterval(() => {
      this.beats++;
      // Every 5 s for the first minute, then every 15 s.
      if (this.beats > 12 && this.beats % 3) return;
      const age = this.lastMsgAt ? `${((performance.now() - this.lastMsgAt) / 1000).toFixed(0)}s ago` : 'none yet';
      this.log(
        'heartbeat',
        `${((performance.now() - started) / 1000).toFixed(0)}s: socket ${['connecting', 'open', 'closing', 'closed'][this.ws?.readyState ?? 3]}, ${this.msgs} msgs (last ${age}), mic chunks sent ${this.micSent}, mic peak ${this.micPeak.toFixed(3)}, audio chunks ${this.totalAudio}, speaker ${this.outCtx?.state}${this.playing ? ' playing' : ''}${this.muted ? ', muted' : ''}`,
      );
      this.micPeak = 0;
    }, 5000);
    this.log('audio ready', `speaker ${this.outCtx?.state} ${this.outCtx?.sampleRate} Hz, mic ${this.micCtx?.state} ${this.micCtx?.sampleRate} Hz`);
    this.log('microphone', this.micInfo);
    await this.open();
    // The interviewer speaks first.
    this.log('kickoff sent');
    this.send({ clientContent: { turns: [{ role: 'user', parts: [{ text: kickoff }] }], turnComplete: true } });
  }

  private open(): Promise<void> {
    this.ready = false;
    const sep = this.wsUrl.includes('?') ? '&' : '?';
    const ws = new WebSocket(`${this.wsUrl}${sep}access_token=${encodeURIComponent(this.token)}`);
    // Array buffers parse synchronously, so messages are handled in the order they arrive.
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail('Gemini Live did not answer the setup in time'), 15_000);
      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.onclose = ws.onmessage = ws.onerror = null;
        ws.close();
        reject(new Error(reason));
      };
      ws.onopen = () => {
        const setup: Record<string, unknown> = { ...this.setup.setup, sessionResumption: this.handle ? { handle: this.handle } : {} };
        this.log('socket open', `setup sent, model ${String(setup.model)}${this.handle ? ', resuming' : ''}`);
        ws.send(JSON.stringify({ setup }));
      };
      this.log('connecting', this.wsUrl.replace(/^wss:\/\/([^/]+)\/.*\.(\w+)$/, '$1 $2'));
      ws.onerror = () => fail('Could not connect to Gemini Live');
      ws.onclose = (e) => fail(`Gemini Live closed the connection (${e.code}${e.reason ? `: ${e.reason}` : ''})`);
      ws.onmessage = (e) => {
        const msg = parse(e.data);
        if (!msg?.setupComplete) {
          this.log('before setup', msg ? Object.keys(msg).join(',') : 'unparsed message');
          return;
        }
        this.log('setup complete');
        settled = true;
        clearTimeout(timer);
        this.ready = true;
        this.h?.onState('listening');
        // A resumed connection: your turn was open, so open it again on the new socket.
        if (this.turnMode === 'button' && this.turnOpen) this.send({ realtimeInput: { activityStart: {} } });
        ws.onmessage = (ev) => {
          this.msgs++;
          this.lastMsgAt = performance.now();
          try {
            this.receive(parse(ev.data));
          } catch (err) {
            this.log('receive error', `${(err as Error).message} | ${String((err as Error).stack ?? '').split('\n').slice(0, 3).join(' | ')}`);
          }
        };
        ws.onerror = null;
        ws.onclose = (ev) => {
          this.log('socket closed', `${ev.code}${ev.reason ? `: ${ev.reason}` : ''}`);
          void this.dropped(`closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`);
        };
        resolve();
      };
    });
  }

  private receive(msg: any): void {
    if (!msg) {
      this.log('unparsed message');
      return;
    }
    const known = ['serverContent', 'toolCall', 'toolCallCancellation', 'goAway', 'sessionResumptionUpdate', 'usageMetadata', 'setupComplete', 'voiceActivity'];
    if (msg.voiceActivity?.type) this.log('voice activity', `${msg.voiceActivity.type}${msg.voiceActivity.audioOffset ? ` at ${msg.voiceActivity.audioOffset}` : ''}`);
    for (const key of Object.keys(msg)) if (!known.includes(key)) this.once(`key:${key}`, 'new message field', `${key}: ${JSON.stringify(msg[key]).slice(0, 300)}`);
    if (msg.sessionResumptionUpdate) this.once('resumption', 'resumption handle', msg.sessionResumptionUpdate.resumable ? 'resumable' : 'not resumable');
    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) this.handle = msg.sessionResumptionUpdate.newHandle;
    if (msg.goAway) {
      this.log('go away', JSON.stringify(msg.goAway).slice(0, 200));
      void this.dropped('go away', true);
      return;
    }
    const c = msg.serverContent;
    if (c) {
      const fields = ['modelTurn', 'inputTranscription', 'outputTranscription', 'interrupted', 'turnComplete', 'generationComplete', 'interactionStatus', 'waitingForInput', 'interimInputTranscription'];
      for (const key of Object.keys(c)) if (!fields.includes(key)) this.once(`content:${key}`, 'new content field', `${key}: ${JSON.stringify(c[key]).slice(0, 300)}`);
      if (c.inputTranscription?.text) {
        this.once(`heard:${this.totalAudio}`, 'hearing you');
        this.h?.onTranscript('candidate', c.inputTranscription.text);
      }
      if (c.outputTranscription?.text) {
        this.h?.onTranscript('interviewer', c.outputTranscription.text);
        this.queueSpoken(c.outputTranscription.text);
      }
      // Live models can put audio and other parts in one event, and its docs show no mimeType on output
      // audio: play every inlineData part unless it is labelled as something other than audio.
      for (const part of c.modelTurn?.parts ?? []) {
        const mime = String(part.inlineData?.mimeType ?? '');
        if (part.inlineData?.data && (!mime || mime.startsWith('audio/'))) {
          if (!this.turnAudio) this.log('audio arriving', mime || 'no mimeType');
          this.turnAudio++;
          this.totalAudio++;
          const pcm = fromBase64(part.inlineData.data);
          if (this.outCtx) this.queuedEnd = Math.max(this.outCtx.currentTime, this.queuedEnd) + pcm.length / this.outCtx.sampleRate;
          this.player?.port.postMessage(pcm, [pcm.buffer]);
        } else if (part.inlineData) this.once(`mime:${mime}`, 'skipped part', mime);
        else if (part.text) this.once('textpart', 'text part', String(part.text).slice(0, 200));
      }
      if (c.interrupted) {
        this.log('interrupted', 'you talked over it, or noise did');
        this.flushPlayer();
      }
      // Extended thinking speaks a filler ("one moment…") while a background tool runs and ends it with
      // turnComplete plus interactionStatus IN_PROGRESS: it is not done, so the candidate's turn must not
      // open yet. It is done at the next turnComplete without IN_PROGRESS, or at a separate IDLE status.
      const working = c.interactionStatus === 'IN_PROGRESS';
      if (c.turnComplete && working) {
        this.log('filler done', `${this.turnAudio} audio chunks, still working (IN_PROGRESS)`);
        this.turnAudio = 0;
        this.fillerPending = true;
      } else if (c.turnComplete || (c.interactionStatus === 'IDLE' && this.fillerPending)) {
        this.log('turn complete', `${this.turnAudio} audio chunks${c.interactionStatus ? `, ${c.interactionStatus}` : ''}`);
        this.turnAudio = 0;
        this.fillerPending = false;
        this.h?.onTurnComplete();
        if (this.turnMode === 'button' && !this.turnOpen) this.openTurn();
      }
    }
    const calls = msg.toolCall?.functionCalls as Array<{ id?: string; name: string; args?: Record<string, unknown> }> | undefined;
    if (msg.toolCallCancellation?.ids?.length) this.log('tool calls cancelled', msg.toolCallCancellation.ids.join(','));
    if (calls?.length && this.h) {
      const list = calls.map((call, i) => ({ id: call.id ?? `call-${i}`, name: call.name, args: call.args ?? {} }));
      this.log('tool call', list.map((c) => c.name).join(', '));
      void this.h
        .onToolCalls(list)
        .catch((err: Error) => list.map(() => ({ error: err.message })))
        .then((responses) => {
          this.send({ toolResponse: { functionResponses: list.map((call, i) => ({ id: call.id, name: call.name, response: responses[i] ?? { error: 'no result' } })) } });
          this.log('tool response sent', list.map((c) => c.name).join(', '));
        });
    }
  }

  private async dropped(reason: string, goAway = false): Promise<void> {
    if (this.closed) return;
    const old = this.ws;
    if (old) {
      old.onclose = old.onmessage = old.onerror = null;
      if (goAway) old.close();
    }
    if (!this.handle || this.resumes >= MAX_RESUMES) return this.finish(reason);
    this.resumes++;
    this.h?.onState('reconnecting');
    try {
      await this.open();
    } catch (err) {
      this.finish(`could not resume: ${(err as Error).message}`);
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.ready) this.ws.send(JSON.stringify(msg));
    else if (!msg.realtimeInput) this.log('not sent', `${Object.keys(msg)[0]}: socket ${this.ws?.readyState}, ready ${this.ready}`);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted && this.turnMode === 'auto') this.send({ realtimeInput: { audioStreamEnd: true } });
  }

  /** Button mode: your turn starts (after each reply, or when you interrupt). */
  private openTurn(): void {
    this.turnOpen = true;
    this.send({ realtimeInput: { activityStart: {} } });
    this.log('your turn', 'activityStart');
    this.h?.onTurn?.('yours');
  }

  /** Button mode: you finished; the voice may answer now. */
  done(): void {
    if (this.turnMode !== 'button' || !this.turnOpen) return;
    this.turnOpen = false;
    this.send({ realtimeInput: { activityEnd: {} } });
    this.log('done answering', 'activityEnd');
    this.h?.onTurn?.('waiting');
  }

  /** Button mode: cut its voice off and take the turn. */
  interrupt(): void {
    if (this.turnMode !== 'button' || this.turnOpen) return;
    this.flushPlayer();
    this.log('interrupted by you');
    this.openTurn();
  }

  /**
   * Pause (someone walked in): nothing from the mic goes out and its voice freezes mid-sentence; Resume
   * carries on from the same word. The connection stays open, and nothing is sent, so it just waits.
   */
  async setPaused(paused: boolean): Promise<void> {
    this.paused = paused;
    this.log(paused ? 'paused' : 'resumed');
    if (paused) await this.outCtx?.suspend();
    else await this.outCtx?.resume();
  }

  /** Resolves once the interviewer's queued speech has played out (or after `maxMs`). */
  async drained(maxMs = 15_000): Promise<void> {
    const until = Date.now() + maxMs;
    await new Promise((r) => setTimeout(r, 400));
    while (this.playing && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  }

  private finish(reason?: string): void {
    if (this.closed) return;
    this.log('finished', reason ?? 'closed by the page');
    if (this.beat) clearInterval(this.beat);
    if (this.spokenTimer) clearInterval(this.spokenTimer);
    this.closed = true;
    this.ready = false;
    if (this.ws) {
      this.ws.onclose = this.ws.onmessage = this.ws.onerror = null;
      this.ws.close();
    }
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micNode?.disconnect();
    void this.micCtx?.close();
    void this.outCtx?.close();
    this.h?.onState('closed');
    this.h?.onClose(reason);
  }

  stop(): void {
    this.finish();
  }
}

function parse(data: unknown): any {
  try {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer);
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
