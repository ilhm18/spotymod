// server.ts
import express from "express";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { fileURLToPath } from "url";
import { promisify } from "util";
import dotenv from "dotenv";
var execFileAsync = promisify(execFile);
dotenv.config();
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
var app = express();
app.use(express.json());
var YTM = "https://music.youtube.com/youtubei/v1";
var CONTEXT = {
  client: {
    clientName: "WEB_REMIX",
    clientVersion: "1.20240101.00.00",
    hl: "id",
    gl: "ID"
  }
};
var HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://music.youtube.com",
  Referer: "https://music.youtube.com/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
};
async function yt(endpoint, body = {}, query = "") {
  const res = await fetch(`${YTM}/${endpoint}?prettyPrint=false${query}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ context: CONTEXT, ...body })
  });
  if (!res.ok) throw new Error(`YTM ${endpoint} -> ${res.status}`);
  return res.json();
}
function findAll(obj, key, out = []) {
  if (!obj || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    for (const v of obj) findAll(v, key, out);
    return out;
  }
  for (const k of Object.keys(obj)) {
    if (k === key) out.push(obj[k]);
    findAll(obj[k], key, out);
  }
  return out;
}
var findFirst = (obj, key) => findAll(obj, key)[0];
var text = (o) => o && o.runs ? o.runs.map((r) => r.text).join("") : o && o.simpleText || "";
function normalizeDuration(s) {
  const t = String(s || "").trim();
  if (/^\d{1,2}(\.\d{2}){1,2}$/.test(t)) return t.replace(/\./g, ":");
  return t;
}
function runsInfo(o) {
  const out = [];
  if (!o || !o.runs) return out;
  for (const r of o.runs) {
    const be = r.navigationEndpoint && r.navigationEndpoint.browseEndpoint;
    if (be) out.push({ name: r.text, browseId: be.browseId });
  }
  return out;
}
function upscale(url) {
  if (!url) return url;
  if (url.includes("googleusercontent.com")) return url.replace(/=w\d+-h\d+.*$/, "=w544-h544-l90-rj");
  return url;
}
function thumbs(o) {
  const t = findAll(o, "thumbnails").flat().filter((x) => x && x.url);
  if (!t.length) return null;
  const best = t.reduce((a, b) => (b.width || 0) >= (a.width || 0) ? b : a);
  return upscale(best.url);
}
function endpointInfo(nav) {
  if (!nav) return {};
  const we = nav.watchEndpoint;
  const be = nav.browseEndpoint;
  const wpe = nav.watchPlaylistEndpoint;
  if (we) return { videoId: we.videoId, playlistId: we.playlistId };
  if (wpe) return { playlistId: wpe.playlistId, watchPlaylist: true };
  if (be) {
    const id = be.browseId;
    let type = "browse";
    if (id.startsWith("MPRE")) type = "album";
    else if (id.startsWith("UC") || id.startsWith("MPLA")) type = "artist";
    else if (id.startsWith("VL") || id.startsWith("PL") || id.startsWith("RDCLAK")) type = "playlist";
    return { browseId: id, browseType: type };
  }
  return {};
}
function parseTwoRow(r) {
  const nav = r.navigationEndpoint || {};
  let info = endpointInfo(nav);
  if (!info.browseId && r.title && r.title.runs) {
    const tNav = r.title.runs[0] && r.title.runs[0].navigationEndpoint;
    const extra = endpointInfo(tNav || {});
    if (extra.browseId) info = { ...info, ...extra };
  }
  let type = "song";
  if (info.browseType === "album" || info.browseType === "playlist" || info.browseType === "artist") type = info.browseType;
  else if (info.videoId) type = "song";
  else if (info.playlistId || info.watchPlaylist) type = "playlist";
  const item = {
    type,
    title: text(r.title),
    subtitle: text(r.subtitle),
    thumbnail: thumbs(r.thumbnailRenderer),
    artists: runsInfo(r.subtitle),
    ...info
  };
  if (r.thumbnailRenderer && findFirst(r, "musicThumbnailRenderer")) {
    const style = findFirst(r, "musicThumbnailRenderer").thumbnailCrop;
    if (style === "MUSIC_THUMBNAIL_CROP_CIRCLE") item.type = "artist";
  }
  return item;
}
function parseListItem(r) {
  const cols = (r.flexColumns || []).map(
    (c) => c.musicResponsiveListItemFlexColumnRenderer ? c.musicResponsiveListItemFlexColumnRenderer.text : null
  );
  const title = cols[0] ? text(cols[0]) : "";
  const subtitle = cols.slice(1).map((c) => text(c)).filter(Boolean).join(" \u2022 ");
  let videoId = null;
  if (r.playlistItemData) videoId = r.playlistItemData.videoId;
  if (!videoId && cols[0] && cols[0].runs) {
    const we = cols[0].runs[0] && cols[0].runs[0].navigationEndpoint && cols[0].runs[0].navigationEndpoint.watchEndpoint;
    if (we) videoId = we.videoId;
  }
  if (!videoId) {
    const we = findFirst(r.overlay || {}, "watchEndpoint");
    if (we) videoId = we.videoId;
  }
  const navInfo = endpointInfo(r.navigationEndpoint);
  const artists = [];
  const albums = [];
  for (const c of cols.slice(1)) {
    for (const e of runsInfo(c)) {
      if (e.browseId.startsWith("MPRE")) albums.push(e);
      else artists.push(e);
    }
  }
  const type = videoId ? "song" : navInfo.browseType || "song";
  const item = {
    type,
    title,
    subtitle,
    videoId,
    thumbnail: thumbs(r.thumbnail),
    artists,
    album: albums[0] || null,
    ...navInfo
  };
  const fixed = findFirst(r, "musicResponsiveListItemFixedColumnRenderer");
  if (fixed) item.duration = normalizeDuration(text(fixed.text));
  return item;
}
function parseSections(contents) {
  const sections = [];
  for (const s of contents || []) {
    const car = s.musicCarouselShelfRenderer;
    const shelf = s.musicShelfRenderer;
    if (car) {
      const header = findFirst(car.header || {}, "title");
      const items = (car.contents || []).map(
        (c) => c.musicTwoRowItemRenderer ? parseTwoRow(c.musicTwoRowItemRenderer) : c.musicResponsiveListItemRenderer ? parseListItem(c.musicResponsiveListItemRenderer) : null
      ).filter((x) => x && x.title);
      if (items.length) sections.push({ title: text(header), items });
    } else if (shelf) {
      const items = (shelf.contents || []).map((c) => c.musicResponsiveListItemRenderer ? parseListItem(c.musicResponsiveListItemRenderer) : null).filter((x) => x && x.title);
      if (items.length) sections.push({ title: text(shelf.title), items, list: true });
    }
  }
  return sections;
}
function continuationCommandToken(item) {
  return item && item.continuationEndpoint && item.continuationEndpoint.continuationCommand && item.continuationEndpoint.continuationCommand.token;
}
function continuationToken(d) {
  const sl = findFirst(d, "sectionListRenderer");
  if (sl && Array.isArray(sl.contents)) {
    for (const item of sl.contents) {
      const cir = item && item.continuationItemRenderer;
      const t = continuationCommandToken(cir);
      if (t) return t;
    }
  }
  for (const item of findAll(d, "continuationItemRenderer")) {
    const t = continuationCommandToken(item);
    if (t) return t;
  }
  const legacy = findFirst(d, "nextContinuationData");
  if (legacy && legacy.continuation) return legacy.continuation;
  return null;
}
function continuationContents(d) {
  const append = findFirst(d, "appendContinuationItemsAction");
  if (append && Array.isArray(append.continuationItems)) return append.continuationItems;
  const legacy = findFirst(d, "sectionListContinuation");
  if (legacy && Array.isArray(legacy.contents)) return legacy.contents;
  const anyItems = findFirst(d, "continuationItems");
  if (Array.isArray(anyItems)) return anyItems;
  return [];
}
var cache = /* @__PURE__ */ new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return Promise.resolve(hit.v);
  return fn().then((v) => {
    cache.set(key, { v, t: Date.now() });
    return v;
  });
}
function collectSearchItems(d) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const shelf of findAll(d, "musicShelfRenderer")) {
    for (const c of shelf.contents || []) {
      if (!c.musicResponsiveListItemRenderer) continue;
      const it = parseListItem(c.musicResponsiveListItemRenderer);
      const k = it.videoId || it.browseId || it.title;
      if (it.title && k && !seen.has(k)) {
        seen.add(k);
        out.push(it);
      }
    }
  }
  return out;
}
app.get("/api/home", async (_req, res) => {
  getSoundCloudClientId(false).catch(() => {
  });
  try {
    const data = await cached("home_ID_v3", 15 * 60 * 1e3, async () => {
      const [dHome, dCharts, dIdTrend, dIdPop, dIdArtist, dIdPls] = await Promise.all([
        yt("browse", { browseId: "FEmusic_home" }).catch(() => null),
        yt("browse", { browseId: "FEmusic_charts" }).catch(() => null),
        yt("search", { query: "Top Hits Indonesia Terbaru Official Chart", params: SEARCH_PARAMS.songs }).catch(() => null),
        yt("search", { query: "Lagu Pop Indonesia Viral TikTok Terbaru", params: SEARCH_PARAMS.songs }).catch(() => null),
        yt("search", { query: "Artis Indonesia Terpopuler Penyanyi Band", params: SEARCH_PARAMS.artists }).catch(() => null),
        yt("search", { query: "Top Hits Indonesia Playlist Spotify", params: SEARCH_PARAMS.playlists }).catch(() => null)
      ]);
      const idSections = [];
      const seenVids = /* @__PURE__ */ new Set();
      const trendSongs = collectSearchItems(dIdTrend).filter((it) => it.videoId);
      const chartSections = dCharts ? parseSections((findFirst(dCharts, "sectionListRenderer") || {}).contents || []) : [];
      const chartSongs = chartSections.flatMap((s) => s.items || []).filter((it) => it && it.videoId);
      const primaryIdSongs = [];
      for (const it of [...trendSongs, ...chartSongs]) {
        if (!it.videoId || seenVids.has(it.videoId)) continue;
        seenVids.add(it.videoId);
        primaryIdSongs.push(it);
        if (primaryIdSongs.length >= 20) break;
      }
      if (primaryIdSongs.length) {
        idSections.push({ title: "Trending & Hits Indonesia", items: primaryIdSongs });
      }
      const popSongs = [];
      for (const it of collectSearchItems(dIdPop)) {
        if (!it.videoId || seenVids.has(it.videoId)) continue;
        seenVids.add(it.videoId);
        popSongs.push(it);
        if (popSongs.length >= 18) break;
      }
      if (popSongs.length) {
        idSections.push({ title: "Pop & Viral Indonesia Terbaru", items: popSongs });
      }
      const artistsItems = collectSearchItems(dIdArtist).filter((it) => it.type === "artist" || it.browseType === "artist").slice(0, 12);
      if (artistsItems.length) {
        idSections.push({ title: "Artis Indonesia Populer", items: artistsItems });
      }
      const idPlaylists = collectSearchItems(dIdPls).filter((it) => it.browseId || it.playlistId).slice(0, 12);
      if (idPlaylists.length) {
        idSections.push({ title: "Playlist Hits Indonesia", items: idPlaylists });
      }
      let homeSections = [];
      if (dHome) {
        const sl = findFirst(dHome, "sectionListRenderer");
        if (sl) homeSections = parseSections(sl.contents);
        let token = continuationToken(dHome) || sl && sl.continuations && sl.continuations[0] && sl.continuations[0].nextContinuationData && sl.continuations[0].nextContinuationData.continuation;
        let n = 0;
        while (token && n < 2) {
          const d2 = await yt("browse", { continuation: token }).catch(() => null);
          if (!d2) break;
          const added = continuationContents(d2);
          if (!added.length) break;
          homeSections = homeSections.concat(parseSections(added));
          token = continuationToken(d2);
          n++;
        }
      }
      const merged = [...idSections, ...homeSections].filter((s) => s && s.items && s.items.length);
      return { sections: merged };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/charts", async (_req, res) => {
  try {
    const data = await cached("charts_ID_v2", 20 * 60 * 1e3, async () => {
      const [dRising, dViral, dGlobalId, dArtists, dPlaylists] = await Promise.all([
        yt("search", { query: "Lagu Indonesia Lagi Naik Daun Viral Terbaru", params: SEARCH_PARAMS.songs }).catch(() => null),
        yt("search", { query: "Top 50 Indonesia Trending Hits Spotify", params: SEARCH_PARAMS.songs }).catch(() => null),
        yt("search", { query: "Lagu Barat Viral di Indonesia TikTok Terbaru", params: SEARCH_PARAMS.songs }).catch(() => null),
        yt("search", { query: "Penyanyi Band Indonesia Lagi Naik Daun Populer", params: SEARCH_PARAMS.artists }).catch(() => null),
        yt("search", { query: "Viral 50 Indonesia Top Hits Playlist", params: SEARCH_PARAMS.playlists }).catch(() => null)
      ]);
      const seenVids = /* @__PURE__ */ new Set();
      const pickSongs = (d, limit) => {
        const out = [];
        for (const it of collectSearchItems(d)) {
          if (!it.videoId || seenVids.has(it.videoId)) continue;
          seenVids.add(it.videoId);
          out.push(it);
          if (out.length >= limit) break;
        }
        return out;
      };
      const sections = [];
      const risingSongs = pickSongs(dRising, 18);
      if (risingSongs.length) {
        sections.push({ title: "Sedang Naik Daun di Indonesia", items: risingSongs, list: true });
      }
      const viralSongs = pickSongs(dViral, 15);
      if (viralSongs.length) {
        sections.push({ title: "Top Hits & Viral Indonesia Saat Ini", items: viralSongs, list: true });
      }
      const risingArtists = collectSearchItems(dArtists).filter((it) => it.type === "artist" || it.browseType === "artist").slice(0, 12);
      if (risingArtists.length) {
        sections.push({ title: "Artis Indonesia yang Lagi Naik Daun", items: risingArtists });
      }
      const globalInId = pickSongs(dGlobalId, 12);
      if (globalInId.length) {
        sections.push({ title: "Lagu Luar yang Lagi Ramai di Indonesia", items: globalInId });
      }
      const idPlaylists = collectSearchItems(dPlaylists).filter((it) => it.browseId || it.playlistId).slice(0, 12);
      if (idPlaylists.length) {
        sections.push({ title: "Playlist Trending Indonesia", items: idPlaylists });
      }
      return { sections };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/sponsorblock", async (req, res) => {
  try {
    const vid = String(req.query.videoId || "");
    const cats = encodeURIComponent(
      JSON.stringify(["sponsor", "selfpromo", "interaction", "intro", "outro", "music_offtopic"])
    );
    const r = await fetch(
      `https://sponsor.ajay.app/api/skipSegments?videoID=${encodeURIComponent(vid)}&categories=${cats}`
    );
    if (!r.ok) return res.json({ segments: [] });
    const arr = await r.json();
    const segments = (Array.isArray(arr) ? arr : []).filter((s) => s && s.actionType === "skip" && Array.isArray(s.segment)).filter((s) => s.locked === 1 || s.locked === true || typeof s.votes !== "number" || s.votes >= 0).map((s) => ({ category: s.category, start: Number(s.segment[0]), end: Number(s.segment[1]) })).filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.start >= 0).sort((a, b) => a.start - b.start);
    res.json({ segments });
  } catch {
    res.json({ segments: [] });
  }
});
app.get("/api/moods", async (_req, res) => {
  try {
    const data = await cached("moods", 60 * 60 * 1e3, async () => {
      const d = await yt("browse", { browseId: "FEmusic_moods_and_genres" });
      const cats = findAll(d, "musicNavigationButtonRenderer").map((b) => ({
        title: text(b.buttonText),
        color: b.solid ? "#" + (b.solid.leftStripeColor >>> 0).toString(16).padStart(8, "0").slice(2) : null,
        browseId: b.clickCommand && b.clickCommand.browseEndpoint && b.clickCommand.browseEndpoint.browseId,
        params: b.clickCommand && b.clickCommand.browseEndpoint && b.clickCommand.browseEndpoint.params
      }));
      return { categories: cats.filter((c) => c.browseId) };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
var SEARCH_PARAMS = {
  songs: "EgWKAQIIAWoMEA4QChADEAQQCRAF",
  videos: "EgWKAQIQAWoMEA4QChADEAQQCRAF",
  albums: "EgWKAQIYAWoMEA4QChADEAQQCRAF",
  artists: "EgWKAQIgAWoMEA4QChADEAQQCRAF",
  playlists: "EgeKAQQoAEABagwQDhAKEAMQBBAJEAU="
};
app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ sections: [] });
    const filter = String(req.query.filter || "");
    const body = { query: q };
    if (filter && SEARCH_PARAMS[filter]) body.params = SEARCH_PARAMS[filter];
    const d = await yt("search", body);
    const sections = [];
    const shelves = findAll(d, "musicShelfRenderer");
    for (const shelf of shelves) {
      const items = (shelf.contents || []).map((c) => c.musicResponsiveListItemRenderer ? parseListItem(c.musicResponsiveListItemRenderer) : null).filter((x) => x && x.title);
      if (items.length) sections.push({ title: text(shelf.title), items });
    }
    if (!sections.length) {
      const flat = [];
      const seen = /* @__PURE__ */ new Set();
      for (const sec of findAll(d, "itemSectionRenderer")) {
        for (const c of sec.contents || []) {
          if (!c.musicResponsiveListItemRenderer) continue;
          const it = parseListItem(c.musicResponsiveListItemRenderer);
          const key = it.videoId || it.browseId || it.title;
          if (it.title && !seen.has(key)) {
            seen.add(key);
            flat.push(it);
          }
        }
      }
      if (flat.length) sections.push({ title: "Results", items: flat });
    }
    const top = findFirst(d, "musicCardShelfRenderer");
    if (top) {
      const info = endpointInfo(
        findFirst(top.title || {}, "navigationEndpoint") || top.title && top.title.runs && top.title.runs[0] && top.title.runs[0].navigationEndpoint
      );
      sections.unshift({
        title: "Top result",
        items: [
          {
            type: info.videoId ? "song" : info.browseType || "song",
            title: text(top.title),
            subtitle: text(top.subtitle),
            thumbnail: thumbs(top.thumbnail),
            ...info
          }
        ]
      });
    }
    res.json({ sections });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/suggest", async (req, res) => {
  try {
    const d = await yt("music/get_search_suggestions", { input: req.query.q || "" });
    const sugg = findAll(d, "searchSuggestionRenderer").map((s) => text(s.suggestion));
    res.json({ suggestions: sugg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/next", async (req, res) => {
  try {
    const body = { isAudioOnly: true, tunerSettingValue: "AUTOMIX_SETTING_NORMAL" };
    if (req.query.videoId) {
      body.videoId = req.query.videoId;
      body.playlistId = req.query.playlistId || `RDAMVM${req.query.videoId}`;
      body.watchEndpointMusicSupportedConfigs = {
        watchEndpointMusicConfig: { musicVideoType: "MUSIC_VIDEO_TYPE_ATV" }
      };
    } else if (req.query.playlistId) {
      body.playlistId = req.query.playlistId;
    }
    if (req.query.params) body.params = req.query.params;
    const d = await yt("next", body);
    const panels = findAll(d, "playlistPanelVideoRenderer");
    const queue = panels.map((p) => ({
      videoId: p.videoId,
      title: displayTitle(text(p.title)),
      artist: text(p.shortBylineText || p.longBylineText),
      artists: runsInfo(p.longBylineText),
      duration: text(p.lengthText),
      thumbnail: thumbs(p.thumbnail),
      selected: !!p.selected
    }));
    let lyricsBrowseId = null;
    let relatedBrowseId = null;
    for (const tab of findAll(d, "tabRenderer")) {
      const id = tab.endpoint && tab.endpoint.browseEndpoint && tab.endpoint.browseEndpoint.browseId;
      if (!id) continue;
      if (id.startsWith("MPLYt")) lyricsBrowseId = id;
      if (id.startsWith("MPTRt")) relatedBrowseId = id;
    }
    res.json({ queue, lyricsBrowseId, relatedBrowseId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/related", async (req, res) => {
  try {
    const d = await yt("browse", { browseId: req.query.browseId });
    const sl = findFirst(d, "sectionListRenderer");
    let sections = sl ? parseSections(sl.contents) : [];
    for (const g of findAll(d, "gridRenderer")) {
      const items = (g.items || []).map((c) => {
        if (c.musicTwoRowItemRenderer) return parseTwoRow(c.musicTwoRowItemRenderer);
        if (c.musicResponsiveListItemRenderer) return parseListItem(c.musicResponsiveListItemRenderer);
        return null;
      }).filter((x) => x && x.title);
      if (items.length) sections.push({ title: text(findFirst(g.header || {}, "title") || {}), items });
    }
    sections = sections.filter((x) => x.items && x.items.length);
    res.json({ sections });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
async function browsePage(rawId, params) {
  let id = rawId || "";
  if (/^(PL|RDCLAK|VLPL|OLAK)/.test(id) && !id.startsWith("VL")) id = "VL" + id;
  const body = { browseId: id };
  if (params) body.params = params;
  const d = await yt("browse", body);
  let header = null;
  const hResp = findFirst(d, "musicResponsiveHeaderRenderer") || findFirst(d, "musicDetailHeaderRenderer") || findFirst(d, "musicImmersiveHeaderRenderer") || findFirst(d, "musicVisualHeaderRenderer") || findFirst(d, "musicEditablePlaylistDetailHeaderRenderer");
  if (hResp) {
    header = {
      title: text(hResp.title),
      subtitle: [text(hResp.subtitle), text(hResp.secondSubtitle)].filter(Boolean).join(" \u2022 "),
      description: text(hResp.description) || text(findFirst(hResp, "description") || {}),
      thumbnail: thumbs(hResp.thumbnail || hResp.foregroundThumbnail || {}),
      artists: runsInfo(hResp.subtitle).concat(runsInfo(hResp.straplineTextOne)),
      strapline: text(hResp.straplineTextOne)
    };
    if (!header.thumbnail) header.thumbnail = thumbs(hResp);
  }
  let playlistId = null;
  const wpe = findFirst(d, "watchPlaylistEndpoint");
  if (wpe) playlistId = wpe.playlistId;
  let tracks = [];
  const shelves = findAll(d, "musicShelfRenderer").concat(findAll(d, "musicPlaylistShelfRenderer"));
  for (const shelf of shelves) {
    const items = (shelf.contents || []).map((c) => c.musicResponsiveListItemRenderer ? parseListItem(c.musicResponsiveListItemRenderer) : null).filter((x) => x && x.title);
    if (items.length && items.filter((i) => i.videoId).length >= items.length / 2 && !tracks.length) {
      tracks = items;
    }
  }
  const sl = findFirst(d, "sectionListRenderer");
  let sections = sl ? parseSections(sl.contents).filter((s) => !s.list || !tracks.length) : [];
  if (tracks.length) {
    sections = sections.filter((s) => !(s.list && s.items[0] && s.items[0].videoId === tracks[0].videoId));
  }
  const grids = findAll(d, "gridRenderer");
  for (const g of grids) {
    const items = (g.items || []).map((c) => c.musicTwoRowItemRenderer ? parseTwoRow(c.musicTwoRowItemRenderer) : null).filter(Boolean);
    if (items.length) sections.push({ title: text(findFirst(g.header || {}, "title") || {}), items });
  }
  if (header && !header.thumbnail && tracks[0]) header.thumbnail = tracks[0].thumbnail;
  if (header && tracks.length) {
    const ha = header.artists && header.artists[0] || (header.strapline ? { name: header.strapline } : null);
    if (ha && ha.name) {
      tracks = tracks.map((t) => {
        if (t.artist || t.artists && t.artists.length) return t;
        return {
          ...t,
          artist: ha.name,
          artists: t.artists && t.artists.length ? t.artists : [ha],
          artistBrowseId: ha.browseId || t.artistBrowseId
        };
      });
    }
  }
  return { header, tracks, sections, playlistId };
}
app.get("/api/browse", async (req, res) => {
  try {
    res.json(await browsePage(String(req.query.id || ""), req.query.params ? String(req.query.params) : void 0));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
var LOADER_API = "https://loader.to/ajax/download.php";
var DL_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
var LOADER_API_KEY = process.env.LOADER_API_KEY || "";
app.get("/api/download-start", async (req, res) => {
  const videoId = String(req.query.videoId || "");
  if (!/^[\w-]{6,20}$/.test(videoId)) return res.status(400).json({ error: "bad id" });
  try {
    const target = encodeURIComponent("https://www.youtube.com/watch?v=" + videoId);
    const u = `${LOADER_API}?format=mp3&url=${target}${LOADER_API_KEY ? `&apikey=${encodeURIComponent(LOADER_API_KEY)}` : ""}`;
    const r = await fetch(u, { headers: { "User-Agent": DL_UA, Referer: "https://loader.to/" } });
    if (!r.ok) {
      return res.status(502).json({ error: `converter responded ${r.status}`, upstreamStatus: r.status });
    }
    let d;
    try {
      d = await r.json();
    } catch {
      return res.status(502).json({ error: "converter returned a non-JSON response (likely rate-limited)" });
    }
    if (!d.success || !d.id) {
      const reason = d.text || d.message || d.error || "converter refused this song";
      return res.status(502).json({ error: String(reason) });
    }
    res.json({ jobId: d.id, progressUrl: d.progress_url, title: d.title || null });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
app.get("/api/download-progress", async (req, res) => {
  const purl = String(req.query.progressUrl || "");
  try {
    const pu = new URL(purl);
    const PROGRESS_HOSTS = ["loader.to", "savenow.to", "affadaffa.com", "oceansaver.in"];
    const host = pu.hostname;
    const okHost = pu.protocol === "https:" && PROGRESS_HOSTS.some((h) => host === h || host.endsWith("." + h));
    if (!okHost) {
      return res.status(400).json({ error: "bad progress url" });
    }
    const r = await fetch(purl, { headers: { "User-Agent": DL_UA } });
    if (!r.ok) throw new Error(`progress -> ${r.status}`);
    const d = await r.json();
    const progress = Number(d.progress) || 0;
    const url = d.download_url || null;
    const done = (d.success === 1 || d.success === true) && !!url;
    const failed = !done && (progress >= 1e3 || d.success === false || d.error || d.status === "error");
    res.json({
      progress,
      done,
      failed: !!failed,
      url,
      text: d.text || d.message || d.error || ""
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
function parseSpotifyTarget(raw) {
  const s = String(raw || "").trim();
  const uriMatch = s.match(/^spotify:(album|playlist|track):([a-zA-Z0-9]{10,40})$/i);
  if (uriMatch) {
    return { spotifyType: uriMatch[1].toLowerCase(), id: uriMatch[2] };
  }
  try {
    const u = new URL(s.includes("://") ? s : "https://" + s);
    if (u.hostname.endsWith("spotify.com")) {
      const pm = u.pathname.match(/\/(?:intl-[a-z-]+\/)?(?:embed\/)?(album|playlist|track)\/([a-zA-Z0-9]{10,40})/i);
      if (pm) {
        return { spotifyType: pm[1].toLowerCase(), id: pm[2] };
      }
    }
  } catch {
  }
  return null;
}
function fmtMsDuration(ms) {
  const sec = Math.max(0, Math.round((Number(ms) || 0) / 1e3));
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
async function matchSpotifyTrackOnYtm(spTrack) {
  const cleanSpTitle = String(spTrack.title || "").replace(/\u00a0/g, " ").trim();
  const cleanSpArtist = String(spTrack.artist || "").replace(/\u00a0/g, " ").trim();
  const primaryArt = cleanSpArtist.split(",")[0].trim();
  const q = `${cleanSpTitle} ${primaryArt}`.trim();
  if (!q) return null;
  let cands = [];
  try {
    const d = await yt("search", { query: q, params: SEARCH_PARAMS.songs });
    cands = collectSearchItems(d).filter((x) => x.videoId);
  } catch {
  }
  if (!cands.length) {
    try {
      const d = await yt("search", { query: q });
      cands = collectSearchItems(d).filter((x) => x.videoId);
    } catch {
    }
  }
  if (!cands.length) return null;
  const targetSec = Math.round((Number(spTrack.durationMs) || 0) / 1e3);
  let best = cands[0];
  let bestScore = -999;
  for (const c of cands.slice(0, 6)) {
    let score = simScore(c.title || "", cleanSpTitle) * 2.5 + simScore(c.subtitle || "", primaryArt) * 1.4;
    if (targetSec && c.duration) {
      const parts = String(c.duration).split(":").map(Number);
      if (parts.length >= 2 && parts.every((n) => Number.isFinite(n))) {
        const cSec = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
        const diff = Math.abs(cSec - targetSec);
        if (diff <= 4) score += 1;
        else if (diff <= 12) score += 0.4;
        else if (diff > 45) score -= 0.8;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return {
    type: "song",
    videoId: best.videoId,
    title: cleanSpTitle || best.title,
    artist: cleanSpArtist || best.subtitle || "",
    subtitle: cleanSpArtist || best.subtitle || "",
    thumbnail: best.thumbnail || spTrack.fallbackCover || null,
    duration: best.duration || fmtMsDuration(spTrack.durationMs || 0),
    artists: best.artists || []
  };
}
app.get("/api/resolve", async (req, res) => {
  try {
    let raw = String(req.query.url || "").trim();
    const spDirect = parseSpotifyTarget(raw);
    if (spDirect) return res.json({ kind: "spotify", ...spDirect });
    let u;
    try {
      u = new URL(raw.includes("://") ? raw : "https://" + raw);
    } catch {
      return res.status(400).json({ error: "Invalid URL" });
    }
    if (u.hostname === "spotify.link" || u.hostname.endsWith(".spotify.link")) {
      try {
        const r = await fetchTimeout(u.toString(), { redirect: "follow", headers: { "User-Agent": DL_UA } }, 6e3);
        const spRedirect = parseSpotifyTarget(r.url);
        if (spRedirect) return res.json({ kind: "spotify", ...spRedirect });
        u = new URL(r.url);
      } catch {
      }
    }
    const spFromUrl = parseSpotifyTarget(u.toString());
    if (spFromUrl) return res.json({ kind: "spotify", ...spFromUrl });
    const list = u.searchParams.get("list");
    const v = u.searchParams.get("v");
    const m = u.pathname.match(/\/(playlist|channel|browse|watch)\/?([^/]*)?/);
    if (list && !v) return res.json({ kind: "playlist", id: list });
    if (v) return res.json({ kind: "song", videoId: v, playlistId: list || null });
    if (u.hostname === "youtu.be" && u.pathname.length > 1) {
      return res.json({ kind: "song", videoId: u.pathname.slice(1).split("/")[0], playlistId: list || null });
    }
    if (m && m[1] === "channel" && m[2]) return res.json({ kind: "artist", id: m[2] });
    if (m && m[1] === "browse" && m[2]) return res.json({ kind: m[2].startsWith("MPRE") ? "album" : "playlist", id: m[2] });
    return res.status(400).json({ error: "Link tidak dikenali. Tempel link album/playlist/lagu Spotify atau YouTube Music." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/spotify-import", async (req, res) => {
  try {
    let type = String(req.query.type || "").toLowerCase();
    let id = String(req.query.id || "").trim();
    if (!id && req.query.url) {
      const parsed = parseSpotifyTarget(String(req.query.url));
      if (parsed) {
        type = parsed.spotifyType;
        id = parsed.id;
      }
    }
    if (!/^(album|playlist|track)$/.test(type) || !/^[a-zA-Z0-9]{10,40}$/.test(id)) {
      return res.status(400).json({ error: "Invalid Spotify album, playlist, or track ID" });
    }
    const embedUrl = `https://open.spotify.com/embed/${type}/${id}`;
    const r = await fetchTimeout(embedUrl, { headers: { "User-Agent": DL_UA } }, 1e4);
    if (!r.ok) return res.status(502).json({ error: `Spotify responded ${r.status}` });
    const html = await r.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return res.status(502).json({ error: "Could not read Spotify data (album/playlist may be private)" });
    const nextData = JSON.parse(m[1]);
    const entity = nextData?.props?.pageProps?.state?.data?.entity;
    if (!entity) return res.status(404).json({ error: "Spotify album or playlist not found" });
    let cover = entity?.coverArt?.sources?.[0]?.url || entity?.visualIdentity?.image?.[0]?.url || null;
    let title = String(entity.name || entity.title || "Spotify Import").trim();
    const subtitle = String(entity.subtitle || (entity.artists || []).map((a) => a.name).join(", ") || "").replace(/\u00a0/g, " ").trim();
    if (!cover) {
      try {
        const oe = await fetchTimeout(`https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/${type}/${id}`)}`, {}, 4e3);
        if (oe.ok) {
          const oj = await oe.json();
          cover = oj.thumbnail_url || null;
          if (!title && oj.title) title = oj.title;
        }
      } catch {
      }
    }
    let rawTracks = [];
    if (type === "track") {
      const art = (entity.artists || []).map((a) => a.name).join(", ") || subtitle;
      rawTracks = [{ title, artist: art, durationMs: Number(entity.duration) || 0 }];
    } else if (Array.isArray(entity.trackList)) {
      rawTracks = entity.trackList.slice(0, 60).map((t) => ({
        title: String(t.title || "").replace(/\u00a0/g, " ").trim(),
        artist: String(t.subtitle || subtitle || "").replace(/\u00a0/g, " ").trim(),
        durationMs: Number(t.duration) || 0
      })).filter((t) => t.title);
    }
    if (!rawTracks.length) {
      return res.status(404).json({ error: "No playable tracks found in this Spotify link" });
    }
    const matched = [];
    const seenVids = /* @__PURE__ */ new Set();
    const BATCH = 5;
    for (let i = 0; i < rawTracks.length; i += BATCH) {
      const chunk = rawTracks.slice(i, i + BATCH);
      const results = await Promise.all(
        chunk.map((t) => matchSpotifyTrackOnYtm({ ...t, fallbackCover: cover }).catch(() => null))
      );
      for (const hit of results) {
        if (hit && hit.videoId && !seenVids.has(hit.videoId)) {
          seenVids.add(hit.videoId);
          matched.push(hit);
        }
      }
    }
    res.json({
      kind: type,
      header: {
        title,
        subtitle: subtitle ? `${subtitle} \u2022 Spotify` : "Spotify Import",
        thumbnail: cover || matched[0] && matched[0].thumbnail || null,
        source: "Spotify"
      },
      totalFound: rawTracks.length,
      tracks: matched
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Spotify import failed" });
  }
});
function displayTitle(t) {
  const raw = String(t || "").trim();
  if (!raw) return "";
  const cleaned = raw.replace(/\s*[\(\[]\s*official\s*(hd\s*)?(4k\s*)?(music\s*)?(lyric(s)?\s*)?(audio|video|visualizer|mv)[^\)\]]*[\)\]]/gi, "").replace(/\s*[\(\[]\s*(official\s*)?(hd\s*)?(music\s*)?(lyric(s)?\s*)?(audio|video|visualizer|mv)[^\)\]]*[\)\]]/gi, "").replace(/\s*[\(\[]\s*(official\s*)?(4k|hd|hq|8d(?:\s*audio)?|1080p|720p)\s*[\)\]]/gi, "").replace(/\s*-\s*(official|lyric(s)?|audio|video|visualizer|topic).*$/gi, "").replace(/\s{2,}/g, " ").trim();
  return cleaned || raw;
}
function cleanTitle(t) {
  return String(t || "").replace(/\((feat|ft|with|prod)[^)]*\)/gi, "").replace(/\[(feat|ft|with|prod)[^\]]*\]/gi, "").replace(/\((official|lyric|lyrics|audio|video|visualizer|music video|mv|hd|4k|remaster(ed)?( \d{4})?|live|acoustic|explicit|clean)[^)]*\)/gi, "").replace(/\[[^\]]*(official|lyric|audio|video|remaster|visualizer|live|mv)[^\]]*\]/gi, "").replace(/[\(\[]\s*(4k|hd|hq|8d( audio)?|1080p|720p)\s*[\)\]]/gi, "").replace(/\s*-\s*(official|lyric|lyrics|audio|video|visualizer|topic).*/gi, "").replace(/\s+/g, " ").trim();
}
function primaryArtist(a) {
  return String(a || "").split(/\s*[,&•·]\s*|\s+(?:feat\.?|ft\.?|with|x|vs\.?)\s+/i)[0].replace(/\s*-\s*topic$/i, "").trim();
}
function norm(x) {
  return String(x || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, " ").trim();
}
function simScore(a, b) {
  a = norm(a);
  b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const aw = new Set(a.split(" "));
  const bw = new Set(b.split(" "));
  let hit = 0;
  for (const w of aw) if (bw.has(w)) hit++;
  return hit / Math.max(aw.size, bw.size);
}
async function fetchTimeout(url, opts = {}, ms = 4500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}
async function lyricsOvh(title, artist) {
  if (!title || !artist) return null;
  try {
    const r = await fetchTimeout(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
    if (!r.ok) return null;
    const j = await r.json();
    const lyr = String(j.lyrics || "").replace(/\r\n/g, "\n").trim();
    return lyr.length > 24 ? lyr : null;
  } catch {
    return null;
  }
}
async function neteaseLyrics(title, artist) {
  try {
    const q = `${title} ${artist}`.trim();
    if (!q) return null;
    const r = await fetchTimeout(
      `https://music.163.com/api/search/get/web?s=${encodeURIComponent(q)}&type=1&limit=8`,
      { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://music.163.com/" } }
    );
    if (!r.ok) return null;
    const j = await r.json();
    const songs = (j.result || {}).songs || [];
    let best = null;
    let bestScore = 0;
    for (const song of songs) {
      const an = (song.artists || []).map((a) => a.name).join(" ");
      const score = simScore(song.name, title) * 2 + simScore(an, artist);
      if (score > bestScore) {
        bestScore = score;
        best = song;
      }
    }
    if (!best || bestScore < 1.4) return null;
    const lr = await fetchTimeout(
      `https://music.163.com/api/song/lyric?id=${best.id}&lv=1&kv=1&tv=-1`,
      { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://music.163.com/" } }
    );
    if (!lr.ok) return null;
    const L = await lr.json();
    const synced = L.lrc && L.lrc.lyric || "";
    const hasTime = /\[[0-9]+:[0-9]/.test(synced);
    if (hasTime && synced.length > 40) {
      const plain2 = synced.replace(/\[[^\]]+\]/g, "").replace(/\n{3,}/g, "\n\n").trim();
      return { synced, plain: plain2 || null };
    }
    const plain = synced.replace(/\[[^\]]+\]/g, "").trim();
    if (plain.length > 24) return { synced: null, plain };
    return null;
  } catch {
    return null;
  }
}
async function lrclibGet(title, artist, duration) {
  try {
    const u = `https://lrclib.net/api/get?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(
      artist
    )}${duration ? `&duration=${Math.round(duration)}` : ""}`;
    const r = await fetchTimeout(u, { headers: { "User-Agent": "SpotifyWeb/1.0" } }, 4e3);
    if (!r.ok) return null;
    const j = await r.json();
    if (j.instrumental) return null;
    return j.syncedLyrics || j.plainLyrics ? j : null;
  } catch {
    return null;
  }
}
async function lrclibSearch(params) {
  try {
    const qs = new URLSearchParams(params).toString();
    const r = await fetchTimeout(`https://lrclib.net/api/search?${qs}`, { headers: { "User-Agent": "SpotifyWeb/1.0" } }, 4e3);
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}
function pickBest(cands, title, artist, duration) {
  const dur = Number(duration) || 0;
  let best = null;
  let bestScore = 0;
  for (const c of cands) {
    if (!c || c.instrumental || !c.syncedLyrics && !c.plainLyrics) continue;
    const tScore = simScore(c.trackName || c.name, title);
    let score = tScore * 2 + simScore(c.artistName, artist);
    if (dur && c.duration) {
      const diff = Math.abs(c.duration - dur);
      if (diff <= 2) score += 1.2;
      else if (diff <= 5) score += 0.6;
      else if (diff > 20) score -= 1;
    }
    if (c.syncedLyrics) score += 0.8;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (!best) return null;
  if (bestScore >= 1.4) return best;
  if (simScore(best.trackName || best.name, title) >= 0.85 && bestScore >= 0.95) return best;
  return null;
}
async function textylLyrics(title, artist) {
  const q = `${artist || ""} ${title || ""}`.trim();
  if (!q) return null;
  try {
    const r = await fetchTimeout(`https://api.textyl.co/api/lyrics?q=${encodeURIComponent(q)}`);
    if (!r.ok) return null;
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length < 4) return null;
    const synced = arr.map((x) => {
      const sec = Number(x.seconds) || 0;
      const m = Math.floor(sec / 60);
      const s = (sec % 60).toFixed(2).padStart(5, "0");
      return `[${m}:${s}]${x.lyrics || ""}`;
    }).join("\n");
    return synced.length > 40 ? synced : null;
  } catch {
    return null;
  }
}
function extractYtmLyrics(d) {
  for (const shelf of findAll(d, "musicDescriptionShelfRenderer")) {
    const lyr = text(shelf.description);
    if (lyr && lyr.length > 20) return lyr;
  }
  for (const block of findAll(d, "formattedDescription")) {
    const lyr = text(block);
    if (lyr && lyr.length > 40 && lyr.split("\n").length > 4) return lyr;
  }
  return null;
}
app.get("/api/lyrics", async (req, res) => {
  const title = String(req.query.title || "");
  const artist = String(req.query.artist || "");
  const duration = Number(req.query.duration) || 0;
  const browseId = String(req.query.browseId || "");
  try {
    const ct = cleanTitle(title);
    const pa = primaryArtist(artist);
    let tUse = ct || title;
    let aUse = pa || artist;
    const dash = String(tUse).match(/^(.{2,48}?)\s*[-–—]\s+(.+)$/);
    if (dash && (!aUse || simScore(dash[1], aUse) >= 0.45)) {
      aUse = aUse || dash[1];
      tUse = dash[2];
    }
    let synced = null;
    let plain = null;
    let source = null;
    if (browseId) {
      try {
        const body = {
          context: { client: { ...CONTEXT.client, hl: "id", gl: "ID" } },
          browseId
        };
        const r = await fetchTimeout(
          `${YTM}/browse?prettyPrint=false`,
          {
            method: "POST",
            headers: HEADERS,
            body: JSON.stringify(body)
          },
          4500
        );
        if (r.ok) {
          const d = await r.json();
          const lyr = extractYtmLyrics(d);
          if (lyr) {
            plain = lyr;
            source = "YouTube Music";
          }
        }
      } catch {
      }
    }
    const exactHits = await Promise.all([
      lrclibGet(tUse, aUse, duration),
      lrclibGet(tUse, aUse, 0),
      title && title !== tUse ? lrclibGet(cleanTitle(title), pa, 0) : null
    ]);
    for (const hit of exactHits) {
      if (!hit) continue;
      synced = synced || hit.syncedLyrics || null;
      plain = plain || hit.plainLyrics || null;
      source = synced ? "LRCLIB" : source || "LRCLIB";
      if (synced) break;
    }
    if (!synced) {
      const [s1, s2, s3, ne, ovh, tx] = await Promise.all([
        lrclibSearch({ track_name: tUse, artist_name: aUse }),
        lrclibSearch({ q: `${tUse} ${aUse}`.trim() }),
        lrclibSearch({ track_name: tUse }),
        neteaseLyrics(tUse, aUse),
        plain ? null : lyricsOvh(tUse, aUse),
        textylLyrics(tUse, aUse)
      ]);
      const best = pickBest([].concat(s1 || [], s2 || [], s3 || []), tUse, aUse, duration);
      if (best) {
        synced = best.syncedLyrics || synced;
        plain = plain || best.plainLyrics;
        source = best.syncedLyrics ? "LRCLIB" : source || "LRCLIB";
      }
      if (!synced && ne && ne.synced) {
        synced = ne.synced;
        plain = plain || ne.plain;
        source = "NetEase";
      } else if (!plain && ne && ne.plain) {
        plain = ne.plain;
        source = source || "NetEase";
      }
      if (!synced && tx) {
        synced = tx;
        source = "Textyl";
      }
      if (!synced && !plain && ovh) {
        plain = ovh;
        source = "lyrics.ovh";
      }
    }
    res.json({ synced: synced || null, plain: plain || null, source });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/thumb", async (req, res) => {
  try {
    const raw = String(req.query.url || "");
    const u = new URL(raw);
    const host = u.hostname;
    const ok = host.endsWith("ytimg.com") || host.endsWith("ggpht.com") || host.endsWith("googleusercontent.com") || host.endsWith("scdn.co") || host.endsWith("spotifycdn.com");
    if (!ok) return res.status(400).end();
    const r = await fetch(raw, {
      headers: { "User-Agent": "Mozilla/5.0 SpotifyThumb/1.0", Accept: "image/*" }
    });
    if (!r.ok) return res.status(502).end();
    res.setHeader("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(500).end();
  }
});
var streamCache = /* @__PURE__ */ new Map();
var streamInFlight = /* @__PURE__ */ new Map();
var scUrlCache = /* @__PURE__ */ new Map();
var scBufferCache = /* @__PURE__ */ new Map();
var scInFlight = /* @__PURE__ */ new Map();
var scClientCache = null;
var scClientInFlight = null;
var ytStreamBlockedUntil = 0;
var PLAYER_CLIENTS = [
  {
    clientName: "ANDROID_VR",
    clientVersion: "1.56.21",
    osName: "Android",
    osVersion: "12L",
    androidSdkVersion: 32
  },
  {
    clientName: "ANDROID_MUSIC",
    clientVersion: "7.02.52",
    osName: "Android",
    osVersion: "13",
    androidSdkVersion: 33
  }
];
async function fetchDirectAudioFromClient(videoId, client) {
  try {
    const res = await fetchTimeout(
      "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, context: { client } })
      },
      1800
    );
    if (!res.ok) return null;
    const data = await res.json();
    const status = data?.playabilityStatus?.status;
    if (status && status !== "OK") return null;
    const adaptive = (data?.streamingData?.adaptiveFormats || []).filter(
      (f) => f && typeof f.mimeType === "string" && f.mimeType.startsWith("audio/") && f.url
    );
    if (!adaptive.length) return null;
    return adaptive.map((f) => ({ ...f, _expiresInSec: Number(data?.streamingData?.expiresInSeconds) || 18e3 }));
  } catch {
    return null;
  }
}
async function resolveAudioStream(videoId, hq = false, prefer = "mp4", forceRefresh = false) {
  const key = `${videoId}:${hq ? "hq" : "std"}:${prefer}`;
  const now = Date.now();
  if (!forceRefresh) {
    const hit = streamCache.get(key);
    if (hit && hit.expiresAt > now + 6e4) return hit;
    const inflight = streamInFlight.get(key);
    if (inflight) return inflight;
  }
  const job = (async () => {
    let adaptive = null;
    try {
      adaptive = await Promise.any(
        PLAYER_CLIENTS.map(async (c) => {
          const r = await fetchDirectAudioFromClient(videoId, c);
          if (!r || !r.length) throw new Error("empty");
          return r;
        })
      );
    } catch {
      adaptive = null;
    }
    if (!adaptive || !adaptive.length) throw new Error("no direct youtube audio streams");
    const mp4 = adaptive.filter((f) => f.mimeType.includes("audio/mp4")).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const webm = adaptive.filter((f) => f.mimeType.includes("audio/webm")).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const all = [...adaptive].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    let chosen = null;
    if (prefer === "webm" && webm.length) {
      chosen = webm[0];
    } else if (mp4.length) {
      chosen = mp4[0];
    } else {
      chosen = all[0];
    }
    const expiresInSec = chosen._expiresInSec || 18e3;
    const resolvedAt = Date.now();
    const info = {
      url: chosen.url,
      mimeType: String(chosen.mimeType).split(";")[0].trim(),
      contentLength: chosen.contentLength ? String(chosen.contentLength) : void 0,
      fetchedAt: resolvedAt,
      expiresAt: resolvedAt + Math.min(expiresInSec, 7200) * 1e3
    };
    streamCache.set(key, info);
    return info;
  })();
  streamInFlight.set(key, job);
  try {
    return await job;
  } finally {
    if (streamInFlight.get(key) === job) streamInFlight.delete(key);
  }
}
async function getSoundCloudClientId(force = false) {
  if (!force && scClientCache && scClientCache.expiresAt > Date.now()) {
    return scClientCache.id;
  }
  if (!force && scClientInFlight) return scClientInFlight;
  const job = (async () => {
    try {
      const home = await fetchTimeout("https://soundcloud.com", { headers: { "User-Agent": DL_UA } }, 3500);
      if (!home.ok) return null;
      const html = await home.text();
      const scripts = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
      const targets = scripts.reverse().slice(0, 6);
      if (!targets.length) return null;
      const found = await Promise.any(
        targets.map(async (s) => {
          const r = await fetchTimeout(s, { headers: { "User-Agent": DL_UA } }, 3e3);
          if (!r.ok) throw new Error("script failed");
          const js = await r.text();
          const m = js.match(/client_id:"([a-zA-Z0-9]{20,40})"/);
          if (!m) throw new Error("no client_id");
          return m[1];
        })
      );
      if (found) {
        scClientCache = { id: found, expiresAt: Date.now() + 6 * 60 * 60 * 1e3 };
        return found;
      }
    } catch {
    }
    return null;
  })();
  scClientInFlight = job;
  try {
    return await job;
  } finally {
    if (scClientInFlight === job) scClientInFlight = null;
  }
}
function setScUrlCache(key, entry) {
  if (scUrlCache.has(key)) scUrlCache.delete(key);
  scUrlCache.set(key, entry);
  while (scUrlCache.size > 48) {
    const oldestKey = scUrlCache.keys().next().value;
    if (oldestKey) scUrlCache.delete(oldestKey);
    else break;
  }
}
function setScBufferCache(key, entry) {
  if (scBufferCache.has(key)) scBufferCache.delete(key);
  scBufferCache.set(key, entry);
  while (scBufferCache.size > 12) {
    const oldestKey = scBufferCache.keys().next().value;
    if (oldestKey) scBufferCache.delete(oldestKey);
    else break;
  }
}
async function lookupTrackMeta(videoId) {
  try {
    const d = await yt("next", { videoId, isAudioOnly: true });
    const p = findFirst(d, "playlistPanelVideoRenderer");
    if (!p) return null;
    const durStr = text(p.lengthText);
    const parts = durStr.split(":").map(Number);
    const durationSec = parts.length === 2 ? parts[0] * 60 + parts[1] : parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : 0;
    return {
      title: displayTitle(text(p.title)),
      artist: text(p.shortBylineText || p.longBylineText),
      durationSec
    };
  } catch {
    return null;
  }
}
function scoreSoundCloudCandidate(cand, targetTitle, targetArtist, targetDurSec) {
  const cTitle = String(cand.title || "");
  const cArtist = String(cand.user?.username || cand.publisher_metadata?.artist || "");
  const combined = `${cTitle} ${cArtist}`.toLowerCase();
  const targetLower = `${targetTitle} ${targetArtist}`.toLowerCase();
  let score = simScore(cTitle, targetTitle) * 3;
  if (targetArtist) {
    score += Math.max(simScore(cArtist, targetArtist), simScore(cTitle, targetArtist)) * 1.5;
  }
  const durSec = Math.round((Number(cand.duration) || 0) / 1e3);
  if (durSec < 45 && (targetDurSec >= 60 || !targetDurSec)) score -= 5;
  if (durSec > 540 && (targetDurSec > 0 ? targetDurSec < 480 : !/(mix|nonstop|album|1\s*jam)/i.test(targetTitle))) score -= 6;
  else if (targetDurSec > 0 && durSec > 0) {
    const diff = Math.abs(durSec - targetDurSec);
    if (diff <= 5) score += 1.4;
    else if (diff <= 15) score += 0.6;
    else if (diff > 60) score -= 2;
  }
  const badMods = ["cover", "remix", "koplo", "dangdut", "karaoke", "instrumental", "slowed", "reverb", "speed up", "sped up", "nightcore", "8d", "live"];
  for (const mod of badMods) {
    if (combined.includes(mod) && !targetLower.includes(mod)) {
      score -= 1.6;
    }
  }
  if (cand.policy === "ALLOW") score += 0.3;
  const hasProg = (cand.media?.transcodings || []).some((tr) => !tr.snipped && tr.format?.protocol === "progressive");
  if (hasProg) score += 0.45;
  return score;
}
async function downloadInBatches(urls, concurrency = 8) {
  const out = new Array(urls.length);
  let idx = 0;
  async function worker() {
    while (idx < urls.length) {
      const i = idx++;
      const r = await fetchTimeout(urls[i], { headers: { "User-Agent": DL_UA } }, 8e3);
      if (!r.ok) throw new Error(`seg ${i} -> ${r.status}`);
      out[i] = Buffer.from(await r.arrayBuffer());
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));
  return out;
}
async function resolveSoundCloudStream(videoId, rawTitle, rawArtist, rawDurSec = 0, forceRefresh = false) {
  if (!forceRefresh) {
    const cachedUrl = scUrlCache.get(videoId);
    if (cachedUrl && cachedUrl.expiresAt > Date.now()) {
      return { kind: "url", url: cachedUrl.url, mimeType: cachedUrl.mimeType, expiresAt: cachedUrl.expiresAt };
    }
    const cachedEntry = scBufferCache.get(videoId);
    if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
      return { kind: "buffer", buf: cachedEntry.buf, mimeType: cachedEntry.mimeType, expiresAt: cachedEntry.expiresAt };
    }
    const existing = scInFlight.get(videoId);
    if (existing) return existing;
  }
  const job = (async () => {
    try {
      let title = displayTitle(cleanTitle(rawTitle) || rawTitle);
      let artist = primaryArtist(rawArtist);
      let durSec = rawDurSec;
      if (!title) {
        const meta = await lookupTrackMeta(videoId);
        if (meta) {
          title = displayTitle(cleanTitle(meta.title) || meta.title);
          artist = primaryArtist(meta.artist);
          if (!durSec) durSec = meta.durationSec;
        }
      }
      if (!title) return null;
      let cid = await getSoundCloudClientId(false);
      if (!cid) return null;
      const queries = [`${title} ${artist}`.trim(), title].filter(Boolean);
      let candidates = [];
      for (const q of queries) {
        let sr = await fetchTimeout(
          `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&client_id=${cid}&limit=10`,
          { headers: { "User-Agent": DL_UA } },
          4e3
        );
        if (sr.status === 401 || sr.status === 403) {
          cid = await getSoundCloudClientId(true);
          if (!cid) return null;
          sr = await fetchTimeout(
            `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&client_id=${cid}&limit=10`,
            { headers: { "User-Agent": DL_UA } },
            4e3
          );
        }
        if (!sr.ok) continue;
        const j = await sr.json();
        const valid = (j.collection || []).filter(
          (t) => (t.media?.transcodings || []).some(
            (tr) => !tr.snipped && tr.duration >= 3e4 && (tr.format?.protocol === "progressive" || (tr.format?.mime_type || "").includes("audio/mp4"))
          )
        );
        if (valid.length) {
          candidates = valid;
          break;
        }
      }
      if (!candidates.length) return null;
      const sorted = candidates.map((c) => ({ c, score: scoreSoundCloudCandidate(c, title, artist, durSec) })).sort((a, b) => b.score - a.score);
      for (const { c } of sorted.slice(0, 3)) {
        const trs = (c.media?.transcodings || []).filter((tr) => !tr.snipped);
        const prog = trs.find((tr) => tr.format?.protocol === "progressive");
        const hlsMp4 = trs.find((tr) => tr.format?.protocol === "hls" && (tr.format?.mime_type || "").includes("audio/mp4"));
        const chosen = prog || hlsMp4;
        if (!chosen) continue;
        const uRes = await fetchTimeout(`${chosen.url}?client_id=${cid}`, { headers: { "User-Agent": DL_UA } }, 3500);
        if (!uRes.ok) continue;
        const uJson = await uRes.json();
        if (!uJson.url) continue;
        if (chosen.format?.protocol === "progressive") {
          const mimeType = (chosen.format?.mime_type || "audio/mpeg").split(";")[0].trim();
          const expiresAt = Date.now() + 25 * 60 * 1e3;
          setScUrlCache(videoId, { url: uJson.url, mimeType, expiresAt });
          return { kind: "url", url: uJson.url, mimeType, expiresAt };
        }
        const m3u8Res = await fetchTimeout(uJson.url, { headers: { "User-Agent": DL_UA } }, 4500);
        if (!m3u8Res.ok) continue;
        const m3u8 = await m3u8Res.text();
        const mapMatch = m3u8.match(/#EXT-X-MAP:URI="([^"]+)"/);
        const segs = m3u8.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("http"));
        if (!segs.length) continue;
        const urls = mapMatch ? [mapMatch[1], ...segs] : segs;
        const chunks = await downloadInBatches(urls, 10);
        const rawBuf = Buffer.concat(chunks);
        const tmpTag = `${videoId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const inPath = path.join(os.tmpdir(), `sp_in_${tmpTag}.mp4`);
        const outPath = path.join(os.tmpdir(), `sp_out_${tmpTag}.m4a`);
        let finalBuf = rawBuf;
        try {
          await fs.writeFile(inPath, rawBuf);
          await execFileAsync("ffmpeg", ["-y", "-v", "error", "-i", inPath, "-c", "copy", "-movflags", "+faststart", outPath], {
            timeout: 8e3
          });
          finalBuf = await fs.readFile(outPath);
        } catch {
        } finally {
          fs.unlink(inPath).catch(() => {
          });
          fs.unlink(outPath).catch(() => {
          });
        }
        const entry = { buf: finalBuf, mimeType: "audio/mp4", expiresAt: Date.now() + 40 * 60 * 1e3 };
        setScBufferCache(videoId, entry);
        return { kind: "buffer", buf: finalBuf, mimeType: "audio/mp4", expiresAt: entry.expiresAt };
      }
      return null;
    } catch {
      return null;
    } finally {
      if (scInFlight.get(videoId) === job) scInFlight.delete(videoId);
    }
  })();
  scInFlight.set(videoId, job);
  return job;
}
function serveBufferRange(req, res, buf, mimeType) {
  const total = buf.length;
  res.setHeader("Content-Type", mimeType || "audio/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-store");
  const rangeHeader = typeof req.headers.range === "string" ? req.headers.range : "";
  const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (m) {
    let start2 = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (!m[1] && m[2]) {
      const suffix = parseInt(m[2], 10);
      start2 = Math.max(0, total - suffix);
      end = total - 1;
    }
    if (!Number.isFinite(start2) || !Number.isFinite(end) || start2 >= total || start2 > end) {
      res.status(416);
      res.setHeader("Content-Range", `bytes */${total}`);
      return res.end();
    }
    end = Math.min(end, total - 1);
    const slice = buf.subarray(start2, end + 1);
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start2}-${end}/${total}`);
    res.setHeader("Content-Length", String(slice.length));
    return res.send(slice);
  }
  res.status(200);
  res.setHeader("Content-Length", String(total));
  return res.send(buf);
}
async function proxyUpstreamUrl(req, res, targetUrl, fallbackMime, fallbackLength, signal) {
  const reqHeaders = { "User-Agent": DL_UA };
  if (typeof req.headers.range === "string") reqHeaders.Range = req.headers.range;
  const upstream = await fetch(targetUrl, { headers: reqHeaders, signal });
  if (!(upstream.ok || upstream.status === 206)) {
    return upstream.status;
  }
  res.status(upstream.status);
  res.setHeader("Content-Type", upstream.headers.get("content-type") || fallbackMime || "audio/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-store");
  const cl = upstream.headers.get("content-length") || fallbackLength;
  if (cl) res.setHeader("Content-Length", cl);
  const cr = upstream.headers.get("content-range");
  if (cr) res.setHeader("Content-Range", cr);
  if (!upstream.body) {
    res.end();
    return upstream.status;
  }
  const nodeStream = Readable.fromWeb(upstream.body);
  nodeStream.on("error", () => {
    if (!res.headersSent) res.status(502).end();
    else res.end();
  });
  nodeStream.pipe(res);
  return upstream.status;
}
app.get("/api/prefetch", async (req, res) => {
  const videoId = String(req.query.videoId || "");
  if (!/^[\w-]{6,20}$/.test(videoId)) return res.json({ ok: false });
  const hq = req.query.hq === "1";
  const prefer = req.query.prefer === "webm" ? "webm" : "mp4";
  const title = String(req.query.title || "").trim();
  const artist = String(req.query.artist || "").trim();
  const dur = Number(req.query.dur) || 0;
  const key = `${videoId}:${hq ? "hq" : "std"}:${prefer}`;
  if (ytStreamBlockedUntil <= Date.now() && streamCache.has(key) || scUrlCache.has(videoId) || scBufferCache.has(videoId)) {
    return res.json({ ok: true, cached: true });
  }
  if (ytStreamBlockedUntil <= Date.now()) {
    try {
      const info = await resolveAudioStream(videoId, hq, prefer, false);
      const probe = await fetchTimeout(info.url, { headers: { Range: "bytes=0-0" } }, 1500);
      if (probe.ok || probe.status === 206) {
        try {
          probe.body?.cancel();
        } catch {
        }
        return res.json({ ok: true, source: "yt" });
      }
      ytStreamBlockedUntil = Date.now() + 3 * 60 * 1e3;
    } catch {
      ytStreamBlockedUntil = Date.now() + 3 * 60 * 1e3;
    }
  }
  const entry = await resolveSoundCloudStream(videoId, title, artist, dur);
  return res.json({ ok: !!entry, source: entry ? "sc" : "none" });
});
app.get("/api/stream", async (req, res) => {
  const videoId = String(req.query.videoId || "");
  if (!/^[\w-]{6,20}$/.test(videoId)) return res.status(400).json({ error: "bad videoId" });
  const hq = req.query.hq === "1";
  const prefer = req.query.prefer === "webm" ? "webm" : "mp4";
  const title = String(req.query.title || "").trim();
  const artist = String(req.query.artist || "").trim();
  const dur = Number(req.query.dur) || 0;
  const cachedScUrl = scUrlCache.get(videoId);
  if (cachedScUrl && cachedScUrl.expiresAt > Date.now()) {
    const ac2 = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ac2.abort();
    });
    try {
      const status = await proxyUpstreamUrl(req, res, cachedScUrl.url, cachedScUrl.mimeType, void 0, ac2.signal);
      if (status >= 200 && status < 300) return;
      scUrlCache.delete(videoId);
    } catch (e) {
      if (e?.name === "AbortError") return;
      scUrlCache.delete(videoId);
    }
  }
  const cachedSc = scBufferCache.get(videoId);
  if (cachedSc && cachedSc.expiresAt > Date.now()) {
    return serveBufferRange(req, res, cachedSc.buf, cachedSc.mimeType);
  }
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  if (!scClientCache || scClientCache.expiresAt <= Date.now()) {
    getSoundCloudClientId(false).catch(() => {
    });
  }
  if (ytStreamBlockedUntil <= Date.now()) {
    try {
      let info = await resolveAudioStream(videoId, hq, prefer, false);
      let status = await proxyUpstreamUrl(req, res, info.url, info.mimeType, info.contentLength, ac.signal);
      if (status >= 200 && status < 300) return;
      if ((status === 403 || status === 410) && Date.now() - info.fetchedAt > 6e4) {
        info = await resolveAudioStream(videoId, hq, prefer, true);
        status = await proxyUpstreamUrl(req, res, info.url, info.mimeType, info.contentLength, ac.signal);
        if (status >= 200 && status < 300) return;
      }
      if (status === 403 || status === 410) {
        ytStreamBlockedUntil = Date.now() + 3 * 60 * 1e3;
      }
    } catch (e) {
      if (e?.name === "AbortError") return;
      ytStreamBlockedUntil = Date.now() + 3 * 60 * 1e3;
    }
  }
  try {
    const scStream = await resolveSoundCloudStream(videoId, title, artist, dur);
    if (scStream && !res.writableEnded) {
      if (scStream.kind === "url") {
        const status = await proxyUpstreamUrl(req, res, scStream.url, scStream.mimeType, void 0, ac.signal);
        if (status >= 200 && status < 300) return;
      } else {
        return serveBufferRange(req, res, scStream.buf, scStream.mimeType);
      }
    }
  } catch (e) {
    if (e?.name === "AbortError") return;
  }
  if (!res.headersSent) res.status(502).json({ error: "stream unavailable" });
});
async function start() {
  const isProd = process.env.NODE_ENV === "production";
  const PORT = 3e3;
  if (isProd) {
    app.use(express.static(path.resolve(__dirname, "dist")));
    app.get("*", (_req, res) => {
      res.sendFile(path.resolve(__dirname, "dist", "index.html"));
    });
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  }
  if (process.env.VERCEL !== "1") {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Spotify running at http://0.0.0.0:${PORT} (${isProd ? "production" : "development"})`);
    });
  }
}
if (process.env.VERCEL !== "1") {
  start();
}
var server_default = app;
export {
  server_default as default
};
