"use client";

import { useEffect } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

/*
 * Imperative effects for the landing page, ported from landing/index.html:
 * ticker tape, split-flap board, WebGL halftone plate and the B1 scroll choreography.
 * The round terminal itself is <RoundTerminal>; this file only animates it on scroll.
 * Everything it creates is tagged data-gen and torn down in cleanup, so React
 * (including StrictMode double effects) and route changes stay safe.
 */

// Demo anchors from MEGA_PLAN §10 — illustrative only; not the server valuation model.
const ANCHOR = { IDEA: 100000, PROTOTYPE: 500000, LAUNCHED: 1000000, REVENUE: 2000000, GROWTH: 5000000 } as const;
type Stage = keyof typeof ANCHOR;

const fmt$ = (n: number, d = 0) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const $ = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;

export default function LandingFX() {
  useEffect(() => {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cleanups: (() => void)[] = [];
    const later = (fn: () => void, ms: number) => { const id = setTimeout(fn, ms); cleanups.push(() => clearTimeout(id)); };
    document.querySelectorAll("[data-gen]").forEach((n) => n.remove());

    /* ── fixtures priced with the demo formula ── */
    const CO = ([
      { t: "QPY", n: "QUIPPY", s: "LAUNCHED", score: 56, sub: 72 },
      { t: "HEART", n: "HEART AEROSPACE", s: "PROTOTYPE", score: 52, sub: 96 },
      { t: "ELMT", n: "ELIMENTARY", s: "LAUNCHED", score: 57, sub: 81 },
      { t: "SNTR", n: "SINTER", s: "PROTOTYPE", score: 55, sub: 63 },
      { t: "PAPY", n: "PAPAYA", s: "LAUNCHED", score: 57, sub: 88 },
      { t: "VYRA", n: "VYRA", s: "LAUNCHED", score: 59, sub: 93 },
      { t: "MEMO", n: "MEMORABLE", s: "LAUNCHED", score: 56, sub: 69 },
      { t: "LINK", n: "LINKLANE", s: "LAUNCHED", score: 59, sub: 76 },
    ] as { t: string; n: string; s: Stage; score: number; sub: number }[])
      .map((c) => ({ ...c, p: Math.round((ANCHOR[c.s] * (0.5 + c.score / 100)) / 1e6 * 100) / 100 }));

    /* ── ticker tape ── */
    const tape = $("tape");
    const tapeHTML = CO.map((c, i) => {
      const full = c.sub >= 100;
      return `<span class="tape-item"><b>${c.t}</b>${fmt$(c.p, 2)} fixed &nbsp;<span class="${full ? "dn" : "up"}">${full ? "■ round full" : `▲ <span class="live" data-sub="${i}">${c.sub.toFixed(1)}%</span> subscribed`}</span></span>`;
    }).join("");
    tape.innerHTML = tapeHTML + tapeHTML;
    cleanups.push(() => { tape.innerHTML = ""; });

    /* ── split-flap board ── */
    const CHARS = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$.%";
    const board = $("board");
    const flapGroup = (len: number, cls = "") => {
      const g = document.createElement("span");
      g.className = "flaps " + cls;
      for (let i = 0; i < len; i++) { const f = document.createElement("span"); f.className = "flap"; f.innerHTML = "<span>&nbsp;</span>"; g.appendChild(f); }
      return g;
    };
    const setFlaps = (g: HTMLElement, text: string, delay = 0) => {
      const cells = [...g.children] as HTMLElement[];
      text = text.padEnd(cells.length).slice(0, cells.length);
      cells.forEach((cell, i) => {
        const span = cell.firstChild as HTMLElement, target = text[i] === " " ? " " : text[i];
        if (reduce) { span.textContent = target; return; }
        const steps = 4 + ((i * 7) % 9); let k = 0;
        const tick = () => {
          cell.classList.remove("go"); void cell.offsetWidth; cell.classList.add("go");
          span.textContent = k >= steps ? target : CHARS[1 + ((Math.random() * (CHARS.length - 1)) | 0)];
          if (k++ < steps) later(tick, 55);
        };
        later(tick, delay + i * 28);
      });
    };
    const rows = CO.map((c) => {
      const row = document.createElement("div");
      row.className = "brow"; row.setAttribute("role", "row"); row.dataset.gen = "";
      const tk = flapGroup(4), nm = flapGroup(17), st = flapGroup(9), pr = flapGroup(5, "g");
      nm.classList.add("name");
      const sub = document.createElement("div"); sub.className = "subbar";
      sub.innerHTML = `<div class="bar${c.sub >= 100 ? " full" : ""}"><i style="width:0"></i></div><span class="pct">0%</span>`;
      row.append(tk, nm, st, pr, sub);
      board.appendChild(row);
      return { c, tk, nm, st, pr, sub };
    });
    const paintSub = (r: (typeof rows)[number]) => {
      const pct = r.sub.querySelector(".pct")!;
      r.sub.querySelector<HTMLElement>("i")!.style.width = Math.min(100, r.c.sub) + "%";
      pct.textContent = r.c.sub >= 100 ? "FULL" : Math.floor(r.c.sub) + "%";
      if (r.c.sub >= 100) { r.sub.querySelector(".bar")!.classList.add("full"); pct.classList.add("dn"); }
    };
    const boardIO = new IntersectionObserver((es) => {
      if (!es[0].isIntersecting) return;
      boardIO.disconnect();
      rows.forEach((r, i) => {
        const d = i * 140;
        setFlaps(r.tk, r.c.t, d); setFlaps(r.nm, r.c.n, d + 60); setFlaps(r.st, r.c.s, d + 120); setFlaps(r.pr, fmt$(r.c.p, 2), d + 180);
        later(() => paintSub(r), d + 400);
      });
    }, { threshold: 0.25 });
    boardIO.observe(board);
    cleanups.push(() => boardIO.disconnect());
    /* ── live commitments: tape + board move together at an uneven, market-like pace ── */
    // Prices stay fixed (primary issuance); only the committed share moves, and only up.
    // Each step slows as a round fills and stops at 99.9%, so no round flips to "full" on screen.
    const tapeLive = [...tape.querySelectorAll<HTMLElement>("[data-sub]")];
    const step = () => {
      const open = rows.filter((r) => r.c.sub < 99.9);
      if (!open.length) return;
      const n = 1 + ((Math.random() * Math.min(4, open.length)) | 0);
      for (const r of [...open].sort(() => Math.random() - 0.5).slice(0, n)) {
        const inc = Math.max(0.1, (100 - r.c.sub) * (0.001 + Math.random() * 0.005));
        r.c.sub = Math.min(99.9, Math.round((r.c.sub + inc) * 10) / 10);
        paintSub(r);
        const i = CO.indexOf(r.c);
        tapeLive.filter((e) => e.dataset.sub === String(i)).forEach((e) => {
          e.textContent = r.c.sub.toFixed(1) + "%";
          e.classList.remove("tick"); void e.offsetWidth; e.classList.add("tick");
        });
      }
    };
    // One self-rescheduling timer (not later(), which would grow cleanups on every print).
    let liveTimer = 0;
    const schedule = () => {
      // Mostly 0.7–2.5 s between prints; about one in eight is a 3–6 s lull.
      const lull = Math.random() < 0.125;
      liveTimer = window.setTimeout(() => { step(); schedule(); }, lull ? 3000 + Math.random() * 3000 : 700 + Math.random() * 1800);
    };
    if (!reduce) { schedule(); cleanups.push(() => clearTimeout(liveTimer)); }

    /* ── halftone WebGL plate ── */
    cleanups.push(initHalftone($<HTMLCanvasElement>("halftone"), reduce));

    /* ── B1 scroll choreography: paper → product ── */
    if (!reduce) {
      gsap.registerPlugin(ScrollTrigger);
      const mm = gsap.matchMedia();
      mm.add("(min-width: 961px)", () => {
        const term = $("term");
        gsap.set(term, { borderColor: "rgba(43,41,37,0)" });
        gsap.set(".L .t-chrome", { opacity: 0 });
        gsap.set(".L .t-in", { opacity: 0, y: 14 });
        gsap.set("#fills", { clipPath: "inset(0 0 100% 0)" });
        gsap.set("#chart .base .ln", { strokeDasharray: 3000, strokeDashoffset: 3000 });
        gsap.set("#chart .base .area, #chart .base .vb", { opacity: 0 });
        gsap.timeline({ scrollTrigger: { trigger: "#stage", start: "top 8%", end: "+=1300", scrub: 0.6, pin: true } })
          .to("#paper > div > *", { opacity: 0, y: -18, stagger: 0.04, duration: 0.5 })
          .to(term, { borderColor: "rgba(43,41,37,1)", duration: 0.4 }, "<.2")
          .to(".L .t-chrome", { opacity: 1, duration: 0.4, stagger: 0.05 }, "<")
          .to(".L .t-in", { opacity: 1, y: 0, stagger: 0.05, duration: 0.5 }, "<.1")
          .to("#fills", { clipPath: "inset(0 0 0% 0)", duration: 0.8, ease: "none" }, "<")
          .to("#chart .base .ln", { strokeDashoffset: 0, duration: 1.2, ease: "none" }, "<.1")
          .to("#chart .base .area", { opacity: 1, duration: 0.6 }, "<.4")
          .to("#chart .base .vb", { opacity: 0.28, stagger: 0.006, duration: 0.2 }, "<");
      });
      cleanups.push(() => mm.revert());
    }

    // Board rows and the B1 pin spacer are inserted after Next has already scrolled
    // to a hash target (e.g. /#rounds from another page), so re-align once layout settles.
    if (location.hash) {
      const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (target) requestAnimationFrame(() => { ScrollTrigger.refresh(); target.scrollIntoView(); });
    }

    return () => {
      cleanups.reverse().forEach((fn) => fn());
      document.querySelectorAll("[data-gen]").forEach((n) => n.remove());
    };
  }, []);

  return null;
}

/** Two-pass WebGL: raymarched Fifth Avenue at golden hour → rotated halftone dot screen. Returns cleanup. */
function initHalftone(cv: HTMLCanvasElement, reduce: boolean): () => void {
  const gl = cv.getContext("webgl", { antialias: false });
  if (!gl) return () => {};
  const VS = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
  // Pass 1, luminance only (red channel): a vague Fifth Avenue looking into a low sun. Setback towers
  // line a wet avenue, a cross street every fifth lot, flags over the sidewalk, and the Empire State
  // silhouette on the axis. The sun sits right under the cursor (m), so facades catch and shadow the
  // light as it moves; t drifts the camera up the avenue.
  const FS1 = `precision highp float;
  uniform vec2 r;uniform float t;uniform vec2 m;
  float h1(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
  float vn(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
    return mix(mix(h1(i),h1(i+vec2(1,0)),u.x),mix(h1(i+vec2(0,1)),h1(i+vec2(1,1)),u.x),u.y);}
  float box(vec3 p,vec3 b){vec3 q=abs(p)-b;return length(max(q,0.))+min(max(q.x,max(q.y,q.z)),0.);}
  float tower(vec3 q,float id,float sd){
    float r1=h1(vec2(id,sd)),r2=h1(vec2(id,sd+7.)),r3=h1(vec2(id,sd+13.));
    float hA=.8+1.3*r1;
    float d=box(q-vec3(3.15,hA*.5,0.),vec3(2.,hA*.5,.57));
    if(r2>.2){float hB=hA+.7+2.4*r2;
      d=min(d,box(q-vec3(3.45,hB*.5,0.),vec3(2.,hB*.5,.5)));
      if(r3>.5){float hC=hB+.5+1.8*r3;
        d=min(d,box(q-vec3(3.8,hC*.5,0.),vec3(2.,hC*.5,.38)));}}
    d=min(d,box(q-vec3(3.1,hA,0.),vec3(2.,.025,.6)));
    if(r3<.5){float wv=sin(t*1.7+id*3.)*.015*(1.15-q.x);
      d=min(d,box(q-vec3(.98,.66,0.),vec3(.17,.006,.006)));
      d=min(d,box(q-vec3(.93,.57+wv,0.),vec3(.11,.075,.004)));}
    return d;}
  // Only the current lot and its nearest neighbour are checked, so march steps are capped at .55.
  float city(vec3 p){
    float sd=p.x>0.?1.:2.;
    vec3 q=vec3(abs(p.x),p.y,p.z);
    float zi=floor(q.z/1.2),zf=q.z-zi*1.2-.6;
    float d=p.y;
    for(int k=0;k<2;k++){
      float id=zi+(k==0?0.:sign(zf+1e-4));
      if(mod(id,5.)<3.5)d=min(d,tower(vec3(q.x,q.y,q.z-id*1.2-.6),id,sd));}
    return d;}
  vec3 nrm(vec3 p){vec2 e=vec2(.0015,0.);
    return normalize(vec3(city(p+e.xyy)-city(p-e.xyy),city(p+e.yxy)-city(p-e.yxy),city(p+e.yyx)-city(p-e.yyx)));}
  float sky(vec3 rd,vec3 sd){
    float s=max(dot(rd,sd),0.);
    vec2 q=rd.xy/max(rd.z,.05)-sd.xy/sd.z;
    float rays=vn(vec2(atan(q.y,q.x)*26.,t*.05));
    float hz=exp(-max(rd.y,0.)*7.);
    return .025+.10*hz+(pow(s,36.)*.30+pow(s,360.)*.25)*(.75+.35*rays)+smoothstep(.99984,.9999,s)*.75;}
  float shadow(vec3 p,vec3 l){float s=1.,d=.03;
    for(int k=0;k<28;k++){float h=city(p+l*d);s=min(s,10.*h/d);d+=clamp(h,.04,.6);if(s<.02||d>18.)break;}
    return clamp(s,0.,1.);}
  float esb(vec2 q){float v=q.y,u=abs(q.x);if(v<0.)return 0.;
    float w=v<.10?.075:v<.22?.052:v<.27?.042:v<.31?.032:v<.335?.022:v<.36?.014:v<.40?.006:v<.47?.0022:0.;
    return step(u,w);}
  void main(){
    vec2 uv=(gl_FragCoord.xy-.5*r)/r.y;
    vec3 ro=vec3(sin(t*.06)*.12,.3,t*.22);
    vec3 rd=normalize(vec3(uv.x,uv.y+.10,1.55));
    vec3 sd=normalize(vec3((m.x-.5)*r.x/r.y,max(m.y-.5+.10,.02),1.55));
    float bg=sky(rd,sd);
    vec2 eq=rd.xy/rd.z/.82;
    if(esb(eq)>.5){bg=mix(.03,bg,.2);if(eq.y>.27&&eq.y<.36)bg+=.12*step(.5,fract(eq.y*90.));}
    float d=.05,hit=-1.;
    for(int i=0;i<160;i++){float h=city(ro+rd*d);if(h<.0008*d){hit=d;break;}d+=min(h,.55);if(d>80.)break;}
    float L=bg;
    if(hit>0.){vec3 p=ro+rd*hit,n=nrm(p);
      if(p.y<.004){
        float glow=sky(reflect(rd,vec3(0,1,0)),sd);
        L=.02+glow*.6*smoothstep(1.2,.1,abs(p.x))*(.55+.45*vn(vec2(p.x*14.,p.z*1.5)));
        L+=step(abs(abs(p.x)-.38),.012)*step(.55,fract(p.z*.7))*.2;
      }else{
        float dif=max(dot(n,sd),0.);
        L=.035+max(n.y,0.)*.10+(dif>0.?dif*.6*shadow(p+n*.004,sd):0.);
        if(abs(n.x)>.5){vec2 g=vec2(p.z*7.,p.y*9.),f=fract(g);
          float win=step(.3,f.x)*step(f.x,.7)*step(.3,f.y)*step(f.y,.72);
          float lit=step(.9,h1(floor(g)+vec2(sign(p.x))+floor(t*.08+h1(floor(g))*6.)));
          L+=win*(lit*.48+.025);
          if(p.y<.24)L+=.22*step(.5,fract(p.z*2.5))*step(.06,p.y);}
        L+=pow(1.-abs(dot(n,rd)),5.)*.25*pow(max(dot(rd,sd),0.),3.);
      }
      L=mix(L,sky(rd,sd),1.-exp(-hit*.03));}
    // Bloom shows through the towers, so the sun visibly tracks the cursor even when it is occluded.
    float sb=max(dot(rd,sd),0.);
    L+=pow(sb,160.)*.38+pow(sb,32.)*.08;
    gl_FragColor=vec4(clamp(L,0.,1.),0.,0.,1.);
  }`;
  const FS2 = `precision highp float;
  uniform sampler2D tx;uniform vec2 r;uniform float cell;uniform float amt;
  void main(){
    float a=.2618;float c=cos(a),s=sin(a);
    vec2 fc=gl_FragCoord.xy;
    vec2 q=vec2(c*fc.x-s*fc.y,s*fc.x+c*fc.y);
    vec2 ce=(floor(q/cell)+.5)*cell;
    vec2 sc=vec2(c*ce.x+s*ce.y,-s*ce.x+c*ce.y);
    float L=texture2D(tx,clamp(sc/r,0.,1.)).r;
    float wave=clamp(amt*1.6-(1.-sc.y/r.y)*.6,0.,1.);
    float rad=cell*.56*sqrt(L)*wave;
    float ink=1.-smoothstep(rad-.9,rad+.9,length(q-ce));
    vec3 bg=vec3(.024,.024,.02);
    vec3 paper=vec3(.925,.898,.827);
    vec3 green=vec3(.357,.816,.416);
    vec3 col=mix(paper,green,smoothstep(.78,.98,L));
    gl_FragColor=vec4(mix(bg,col,ink),1.);
  }`;
  const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = (fs: string) => { const p = gl.createProgram()!; gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); return p; };
  const P1 = prog(FS1), P2 = prog(FS2);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const tex = gl.createTexture(), fb = gl.createFramebuffer();
  let W2 = 0, H2 = 0, tw = 0, th = 0, cell = 6;
  const mouse = { x: 0.62, y: 0.5, tx: 0.62, ty: 0.5 };
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W2 = Math.round(cv.clientWidth * dpr); H2 = Math.round(cv.clientHeight * dpr);
    cv.width = W2; cv.height = H2;
    cell = (innerWidth < 700 ? 5 : 6.5) * dpr;
    tw = Math.ceil(W2 / cell * 2); th = Math.ceil(H2 / cell * 2);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  };
  const t0 = performance.now();
  const draw = (now: number) => {
    const time = now - t0;
    mouse.x += (mouse.tx - mouse.x) * 0.05; mouse.y += (mouse.ty - mouse.y) * 0.05;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, tw, th); gl.useProgram(P1);
    let loc = gl.getAttribLocation(P1, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(gl.getUniformLocation(P1, "r"), tw, th);
    gl.uniform1f(gl.getUniformLocation(P1, "t"), 40 + time * 0.001);
    gl.uniform2f(gl.getUniformLocation(P1, "m"), mouse.x, mouse.y);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W2, H2); gl.useProgram(P2);
    loc = gl.getAttribLocation(P2, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(gl.getUniformLocation(P2, "r"), W2, H2);
    gl.uniform1f(gl.getUniformLocation(P2, "cell"), cell);
    gl.uniform1f(gl.getUniformLocation(P2, "amt"), reduce ? 1 : Math.min(1, Math.max(0, (time - 350) / 1900)));
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  resize();
  // The hero plate tracks the viewport height (landing.css), so watch the canvas, not just the window.
  const ro = new ResizeObserver(resize);
  ro.observe(cv);
  const plate = cv.parentElement!;
  const onMove = (e: PointerEvent) => { const b = cv.getBoundingClientRect(); mouse.tx = (e.clientX - b.left) / b.width; mouse.ty = 1 - (e.clientY - b.top) / b.height; };
  plate.addEventListener("pointermove", onMove);
  let visible = true, raf = 0;
  const io = new IntersectionObserver((es) => (visible = es[0].isIntersecting));
  io.observe(cv);
  if (reduce) draw(t0 + 4000);
  else { const loop = (t: number) => { if (visible) draw(t); raf = requestAnimationFrame(loop); }; raf = requestAnimationFrame(loop); }
  return () => {
    cancelAnimationFrame(raf); io.disconnect();
    ro.disconnect(); plate.removeEventListener("pointermove", onMove);
  };
}
