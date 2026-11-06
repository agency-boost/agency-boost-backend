import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LESSON_COLOUR_READER, LESSON_READER_MARKER, loadLessonSet, type LessonSet } from './lesson-files';

/**
 * **The 23 delivered lessons, served as the import stores them, read in a real browser** (P19.6-T3 AC-5, AC-7;
 * ADR-0217 §4, §5).
 *
 * Each served copy — the delivered `default.html` with the served script (the colour reader and the scroll keeper) — is
 * served by one local server standing in for the storage host, and framed by another standing in for the app, with
 * `SandboxedDocument`'s attributes (`sandbox="allow-scripts"`, `allow=""`, `referrerpolicy="no-referrer"`), filling
 * the content width, 480 px high, at 375, 768, 1024 and 1280 px, on a page that can scroll. The KPM's colours ride in
 * the fragment. **A probe is added to the copy this spec serves**, and to no stored file: it reports the lesson's
 * colours as the page computes them and how much wider than its frame the lesson is, follows the lesson's own furthest
 * anchor link, and posts what it found to the page — a sandboxed page may still post a message.
 *
 * - **The control**: lesson 01 with the colour reader alone, as the served copy was before the scroll keeper. Its link
 *   scrolls the page around the frame, which is what the keeper exists to stop — so a pass is not a page that could not
 *   scroll.
 * - **Two delivered lessons are wider than a frame at one width** (`WIDER_THAN_THEIR_FRAME`): the owner's own layout,
 *   frozen input this phase does not edit. Each still opens and reads, scrolling sideways inside its frame by the few
 *   pixels pinned there; any other lesson, or a wider overflow, fails.
 *
 * **Skipped where no Chrome is installed** (`CHROME_PATH`, or the usual places on macOS and Linux), **or where the
 * delivered folder is not beside this repository** — a CI checkout of the backend alone has the superproject's
 * `docs/` and `prototype/`, never `revisions/`. A laptop with the superproject has both.
 */
const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((path): path is string => !!path && existsSync(path));
const DELIVERED = resolve(__dirname, '../../../../revisions/2026-11-03/files/training-modules');
const runnable = !!CHROME && existsSync(join(DELIVERED, 'index.html'));

const WIDTHS = [375, 768, 1024, 1280] as const;
/** The same attributes `SANDBOXED_FRAME` sets (`frontend/src/components/sandboxed-document.tsx`; ADR-0217 §4). */
const FRAME = { sandbox: 'allow-scripts', allow: '', referrerPolicy: 'no-referrer' } as const;
/** A KPM's colours as `GET /auth/me`'s `branding.lesson` gives them: green primary, dark blue secondary. */
const COLOURS = { accent: '0e7c66', accentSoft: 'e7f2f0', ink: '1f2a44' };
const FRAGMENT = `#${Object.entries(COLOURS).map(([name, value]) => `${name}=${value}`).join('&')}`;

/**
 * **The delivered lessons wider than their frame**, found 2026-11-06 in Chrome, by width, with the most they overflow:
 * the owner's layout, for the owner to refresh (the phase file's T3 *Progress*). Lesson 19's first table sits in a
 * column that does not shrink below it at a phone's width; lesson 05 has a line wider than its column at a tablet's.
 */
const WIDER_THAN_THEIR_FRAME: Readonly<Record<string, { width: number; atMostPx: number }>> = {
  '19-building-trust-situational-leadership': { width: 375, atMostPx: 40 },
  '05-cross-sell-retensi': { width: 768, atMostPx: 32 },
};

/** What each lesson says: its colours, its fit, and whether its own anchor moved it. */
const PROBE = `<script>
(function () {
  function report() {
    var css = getComputedStyle(document.documentElement);
    var read = function (name) { return css.getPropertyValue(name).trim().toLowerCase(); };
    var links = [].slice.call(document.querySelectorAll('a[href^="#"]')).filter(function (a) {
      return a.getAttribute('href').length > 1 && document.getElementById(a.getAttribute('href').slice(1));
    });
    var top = function (a) { return document.getElementById(a.getAttribute('href').slice(1)).offsetTop; };
    var furthest = links.sort(function (a, b) { return top(b) - top(a); })[0];
    var meta = document.querySelector('meta[name="module-key"]');
    var found = {
      tag: (meta ? meta.content : location.pathname) + (location.pathname.indexOf('/control/') === 0 ? ':control' : ''),
      accent: read('--accent'), accentSoft: read('--accent-soft'), ink: read('--ink'),
      green: read('--green'), red: read('--red'), blue: read('--blue'),
      width: window.innerWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      anchors: links.length,
    };
    if (!furthest) { parent.postMessage(found, '*'); return; }
    furthest.click();
    setTimeout(function () { found.scrolledInside = window.scrollY > 0; parent.postMessage(found, '*'); }, 1500);
  }
  // Once the frame has its size: at load a frame may not have been laid out at its width yet.
  function later() { setTimeout(report, 500); }
  if (document.readyState === 'complete') later(); else window.addEventListener('load', later);
})();
</script>`;

/** The app's page: the frames, and room below them, so a link that scrolled the page would show. */
const appPage = (sources: string[]) => `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>app</title></head>
<body style="margin:0">
<main id="main" style="padding:16px">
${sources.map((src, i) => `<iframe title="lesson ${i + 1}" sandbox="${FRAME.sandbox}" allow="${FRAME.allow}" referrerpolicy="${FRAME.referrerPolicy}"
  style="display:block;width:100%;height:480px;border:0;margin-bottom:10px" src="${src}"></iframe>`).join('\n')}
</main>
<div style="height:4000px"></div>
<script>
  window.__found = {};
  window.addEventListener('message', function (e) { window.__found[e.data.tag] = e.data; });
</script>
</body></html>`;

function serve(handler: (path: string, query: URLSearchParams) => string | null): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = handler(url.pathname, url.searchParams);
    res.writeHead(body === null ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body ?? '');
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}
const originOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** A page of the browser, driven over the DevTools protocol with Node's own WebSocket. */
class Tab {
  private next = 0;
  private waiting = new Map<number, (value: unknown) => void>();
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
      if (message.id !== undefined) this.waiting.get(message.id)?.(message.result);
    });
  }

  static async open(devtools: string): Promise<Tab> {
    const target = await (await fetch(`${devtools}/json/new?about:blank`, { method: 'PUT' })).json() as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((done, fail) => {
      socket.addEventListener('open', done, { once: true });
      socket.addEventListener('error', fail, { once: true });
    });
    return new Tab(socket);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.next;
    return new Promise<T>((done) => {
      this.waiting.set(id, done as (value: unknown) => void);
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const answer = await this.send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true });
    return answer.result.value;
  }

  close() {
    this.socket.close();
  }
}

interface Found {
  tag: string; accent: string; accentSoft: string; ink: string; green: string; red: string; blue: string;
  width: number; overflow: number; anchors: number; scrolledInside?: boolean;
}
interface Page { main: number; frames: number[]; scrollY: number }

(runnable ? describe : describe.skip)('P19.6-T3 the 23 lessons in the sandboxed frame, in a real browser', () => {
  let set: LessonSet;
  let chrome: ChildProcess;
  let profile: string;
  let storage: Server;
  let app: Server;
  let tab: Tab;

  beforeAll(async () => {
    set = loadLessonSet(DELIVERED);
    const probed = (html: string) => html.replace(/<\/body>/i, `${PROBE}</body>`);
    const served = new Map(set.lessons.map((lesson) => [lesson.number, probed(lesson.html.toString('utf8'))]));
    // The control: the delivered lesson 01 with the colour reader alone.
    const delivered = readFileSync(join(DELIVERED, set.lessons[0].folder, 'default.html'), 'utf8');
    const control = probed(delivered.replace(/<\/head>/i, `<script ${LESSON_READER_MARKER}>(function(){${LESSON_COLOUR_READER}})();</script></head>`));
    storage = await serve((path) => {
      if (path === '/control/1.html') return control;
      const match = /^\/lesson\/(\d+)\.html$/.exec(path);
      return match ? served.get(Number(match[1])) ?? null : null;
    });
    app = await serve((_path, query) => {
      if (query.get('control')) return appPage([`${originOf(storage)}/control/1.html${FRAGMENT}`]);
      const fragment = query.get('plain') ? '' : FRAGMENT;
      return appPage(set.lessons.map((lesson) => `${originOf(storage)}/lesson/${lesson.number}.html${fragment}`));
    });
    profile = mkdtempSync(join(tmpdir(), 'ab-lessons-'));
    chrome = spawn(CHROME!, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
      '--no-default-browser-check', '--disable-gpu', '--no-sandbox', '--remote-allow-origins=*', 'about:blank',
    ]);
    const devtools = await new Promise<string>((done, fail) => {
      let said = '';
      chrome.stderr!.on('data', (chunk: Buffer) => {
        said += chunk.toString();
        const found = /DevTools listening on ws:\/\/([^/]+)\//.exec(said);
        if (found) done(`http://${found[1]}`);
      });
      chrome.once('exit', () => fail(new Error(`Chrome exited: ${said}`)));
    });
    tab = await Tab.open(devtools);
    await tab.send('Page.enable');
    await tab.send('Runtime.enable');
  }, 60_000);

  afterAll(async () => {
    tab?.close();
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise((done) => chrome.once('exit', done));
      chrome.kill();
      await exited;
    }
    await Promise.all([app, storage].map((s) => s && new Promise((done) => s.close(done))));
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /**
   * Load the app's page at a width and wait for every frame to report. The screen is as tall as the frames, so each is
   * on it — Chrome pauses an off-screen frame's smooth scroll, and the app draws one at a time — and the page still
   * scrolls by the room below them.
   */
  async function at(width: number, query = ''): Promise<{ found: Record<string, Found>; page: Page }> {
    const frames = query.includes('control') ? 1 : set.lessons.length;
    await tab.send('Emulation.setDeviceMetricsOverride', {
      width, height: frames * 490 + 64, deviceScaleFactor: 1, mobile: width < 768,
    });
    await tab.send('Page.navigate', { url: `${originOf(app)}/${query}` });
    for (let tries = 0; tries < 300; tries += 1) {
      const found = await tab.evaluate<Record<string, Found> | null>(
        `document.readyState === "complete" && window.__found && Object.keys(window.__found).length === ${frames} ? window.__found : null`,
      );
      if (found) {
        const page = await tab.evaluate<Page>(`({
          main: document.getElementById('main').clientWidth - 32,
          frames: [...document.querySelectorAll('iframe')].map((f) => f.getBoundingClientRect().width),
          scrollY: window.scrollY,
        })`);
        return { found, page };
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`The lessons did not all report at ${width}px.`);
  }

  it.each(WIDTHS)('P19.6-T3 AC-7 at %ipx each lesson opens in the frame at its width and reads, and its anchors move the lesson, not the page', async (width) => {
    const { found, page } = await at(width);
    expect(Object.keys(found).sort()).toEqual(set.lessons.map((lesson) => lesson.folder).sort());
    for (const frame of page.frames) expect(Math.round(frame)).toBe(page.main);
    for (const lesson of Object.values(found)) {
      expect([lesson.tag, lesson.width]).toEqual([lesson.tag, page.main]);
      const wider = WIDER_THAN_THEIR_FRAME[lesson.tag];
      const allowed = wider?.width === width ? wider.atMostPx : 1;
      expect([lesson.tag, lesson.overflow <= allowed]).toEqual([lesson.tag, true]);
      expect([lesson.tag, lesson.anchors > 0, lesson.scrolledInside]).toEqual([lesson.tag, true, true]);
    }
    expect(page.scrollY).toBe(0);
  }, 120_000);

  it('P19.6-T3 AC-7 the control: without the scroll keeper, a delivered lesson’s link scrolls the page around its frame', async () => {
    const { found, page } = await at(1024, '?control=1');
    expect(found['01-leads-generation-tactics:control'].scrolledInside).toBe(true);
    expect(page.scrollY).toBeGreaterThan(0);
  }, 120_000);

  it('P19.6-T3 AC-5 each lesson takes the KPM’s primary as its accent and its secondary as its ink; its status colours do not move', async () => {
    const { found } = await at(1024);
    for (const lesson of Object.values(found)) {
      expect([lesson.tag, lesson.accent, lesson.accentSoft, lesson.ink]).toEqual([
        lesson.tag, `#${COLOURS.accent}`, `#${COLOURS.accentSoft}`, `#${COLOURS.ink}`,
      ]);
      expect([lesson.tag, lesson.green, lesson.red, lesson.blue]).toEqual([lesson.tag, '#2f7d4f', '#c2410c', '#3b5bdb']);
    }
  }, 120_000);

  it('P19.6-T3 AC-5 without the KPM’s branding, each lesson keeps its own colours', async () => {
    const { found } = await at(1024, '?plain=1');
    for (const lesson of Object.values(found)) {
      expect([lesson.tag, lesson.accent, lesson.accentSoft, lesson.ink]).toEqual([lesson.tag, '#d9822b', '#fdf1e4', '#1c2340']);
    }
  }, 120_000);
});
