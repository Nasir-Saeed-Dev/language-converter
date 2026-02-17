(function () {
  var MAX_AGE = 60 * 60 * 24 * 365;
  var FALLBACK_CONCURRENCY = 4;

  // Used to revert fallback translations when switching back to English.
  var originalTextByNode = typeof WeakMap !== "undefined" ? new WeakMap() : null;
  var originalAttrsByEl = typeof WeakMap !== "undefined" ? new WeakMap() : null;
  var translationCache = {};
  var fallbackObserver = null;
  var fallbackActive = false;
  var fallbackRunId = 0;

  function hostDomains() {
    var host = window.location.hostname || "";
    if (!host || host.indexOf(".") === -1) return [""];
    // Try to cover both www/non-www without needing a public suffix list.
    var noWww = host.replace(/^www\./i, "");
    var domains = ["", "." + host];
    if (noWww && noWww !== host) domains.push("." + noWww);
    return domains;
  }

  function getCookie(name) {
    try {
      var match = document.cookie.match(new RegExp("(^|;\\s*)" + name + "=([^;]*)"));
      return match ? decodeURIComponent(match[2] || "") : "";
    } catch (e) {
      return "";
    }
  }

  function normalizedHomePath() {
    var data = window.lcpData || {};
    var raw = data.homePath || "/";
    var p = String(raw || "/");
    if (p.charAt(0) !== "/") p = "/" + p;
    p = p.replace(/\/+$/, "");
    return p || "/";
  }

  function stripHomePath(pathname) {
    var path = String(pathname || "/");
    if (path.charAt(0) !== "/") path = "/" + path;
    var home = normalizedHomePath();
    if (home === "/") return path;
    if (path === home) return "/";
    if (path.indexOf(home + "/") === 0) return path.slice(home.length) || "/";
    return path;
  }

  function langFromPathname() {
    var p = stripHomePath(window.location.pathname || "").toLowerCase();
    if (p.indexOf("/fr/") === 0 || p === "/fr") return "fr";
    if (p.indexOf("/en/") === 0 || p === "/en") return "en";
    return "";
  }

  function resolveInitialLang() {
    var fromPath = langFromPathname();
    if (fromPath === "en" || fromPath === "fr") return fromPath;

    var fromCookie = (getCookie("lcp_lang") || "").toLowerCase();
    if (fromCookie === "en" || fromCookie === "fr") return fromCookie;

    var data = window.lcpData || {};
    var fromData = (data.currentLang || "").toLowerCase();
    if (fromData === "en" || fromData === "fr") return fromData;

    return "en";
  }

  function setCookie(name, value, maxAge, domain) {
    var cookie = name + "=" + value + "; path=/; max-age=" + maxAge;
    if (domain) cookie += "; domain=" + domain;
    document.cookie = cookie;
  }

  function deleteCookie(name, domain) {
    var cookie = name + "=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    if (domain) cookie += "; domain=" + domain;
    document.cookie = cookie;
  }

  function setLangCookie(lang) {
    hostDomains().forEach(function (domain) {
      setCookie("lcp_lang", lang, MAX_AGE, domain);
    });
  }

  function setGoogleCookie(lang) {
    var value = lang === "fr" ? "/en/fr" : "/en/en";
    hostDomains().forEach(function (domain) {
      setCookie("googtrans", value, MAX_AGE, domain);
    });
  }

  function clearGoogleCookie() {
    hostDomains().forEach(function (domain) {
      deleteCookie("googtrans", domain);
    });
  }

  function getCombo() {
    return document.querySelector(".goog-te-combo");
  }

  function applyComboLang(lang, attempt) {
    var tries = typeof attempt === "number" ? attempt : 0;
    var combo = getCombo();
    if (!combo) {
      if (tries < 60) {
        setTimeout(function () {
          applyComboLang(lang, tries + 1);
        }, 200);
      }
      return;
    }

    combo.value = lang;
    combo.dispatchEvent(new Event("change"));
  }

  function isGoogleTranslated() {
    var htmlClass = document.documentElement.className || "";
    var bodyClass = document.body ? document.body.className || "" : "";
    return htmlClass.indexOf("translated") !== -1 || bodyClass.indexOf("translated") !== -1;
  }

  function canUseWeakMap() {
    return !!originalTextByNode && !!originalAttrsByEl;
  }

  function rememberOriginalText(node) {
    if (!canUseWeakMap() || !node) return;
    if (originalTextByNode.has(node)) return;
    originalTextByNode.set(node, node.nodeValue || "");
  }

  function revertFallbackToEnglish() {
    fallbackActive = false;
    fallbackRunId++;
    if (fallbackObserver) {
      try { fallbackObserver.disconnect(); } catch (e) {}
      fallbackObserver = null;
    }
    if (!canUseWeakMap()) return;

    // Revert text nodes we have touched.
    try {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      var n;
      while ((n = walker.nextNode())) {
        if (originalTextByNode.has(n)) {
          n.nodeValue = originalTextByNode.get(n);
        }
      }
    } catch (e) {}

    // Revert attributes we have touched.
    try {
      var els = document.querySelectorAll("[data-lcp-attribs]");
      els.forEach(function (el) {
        var raw = el.getAttribute("data-lcp-attribs") || "";
        if (!raw) return;
        var parts = raw.split("|");
        parts.forEach(function (pair) {
          var idx = pair.indexOf("=");
          if (idx === -1) return;
          var key = pair.slice(0, idx);
          var val = pair.slice(idx + 1);
          if (key) el.setAttribute(key, val);
        });
        el.removeAttribute("data-lcp-attribs");
      });
    } catch (e) {}
  }

  function shouldSkipNode(node) {
    if (!node || !node.parentNode) return true;
    var tag = node.parentNode.nodeName;
    if (!tag) return true;
    tag = tag.toUpperCase();
    if (
      tag === "SCRIPT" ||
      tag === "STYLE" ||
      tag === "NOSCRIPT" ||
      tag === "IFRAME" ||
      tag === "TEXTAREA" ||
      tag === "OPTION" ||
      tag === "CODE" ||
      tag === "PRE"
    ) {
      return true;
    }
    if (node.parentNode.closest && node.parentNode.closest(".lcp-switcher")) return true;
    return false;
  }

  function collectTextNodes() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    var nodes = [];
    var current;
    while ((current = walker.nextNode())) {
      if (shouldSkipNode(current)) continue;
      var raw = current.nodeValue || "";
      var text = raw.trim();
      if (!text) continue;
      // Keep the filter loose; the API will be called on trimmed text.
      if (text.length < 2) continue;
      nodes.push(current);
    }
    return nodes;
  }

  function shouldSkipElement(el) {
    if (!el || !el.tagName) return true;
    if (el.closest && el.closest(".lcp-switcher")) return true;
    var tag = (el.tagName || "").toUpperCase();
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "IFRAME") return true;
    return false;
  }

  function collectAttributeTargets() {
    // Translate visible UI strings that live in attributes too.
    var attrs = ["title", "alt", "placeholder", "aria-label"];
    var selector = attrs.map(function (a) { return "[" + a + "]"; }).join(",");
    var els = [];
    try {
      document.querySelectorAll(selector).forEach(function (el) {
        if (shouldSkipElement(el)) return;
        els.push(el);
      });
    } catch (e) {}
    return { els: els, attrs: attrs };
  }

  function translateTextFree(text) {
    var data = window.lcpData || {};
    if (!data.ajaxUrl || !data.nonce) {
      return Promise.resolve(text);
    }

    var body = new URLSearchParams();
    body.append("action", "lcp_translate_text");
    body.append("nonce", data.nonce);
    body.append("text", text);

    return fetch(data.ajaxUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
      },
      body: body.toString(),
      credentials: "same-origin"
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.success && data.data && data.data.translated) {
          return data.data.translated;
        }
        return text;
      })
      .catch(function () {
        return text;
      });
  }

  function cacheKey(lang, text) {
    return (lang || "en") + "::" + text;
  }

  function translateToFrenchCached(text) {
    var key = cacheKey("fr", text);
    if (translationCache[key]) return Promise.resolve(translationCache[key]);
    return translateTextFree(text).then(function (t) {
      translationCache[key] = t || text;
      return translationCache[key];
    });
  }

  function chunkText(text, maxLen) {
    var s = (text || "").trim();
    if (!s) return [""];
    if (s.length <= maxLen) return [s];

    var words = s.split(/\s+/);
    var out = [];
    var cur = "";
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w) continue;
      if (!cur) {
        cur = w;
        continue;
      }
      if ((cur + " " + w).length <= maxLen) {
        cur += " " + w;
      } else {
        out.push(cur);
        cur = w;
      }
    }
    if (cur) out.push(cur);
    return out.length ? out : [s];
  }

  function translateLongToFrench(text) {
    var t = (text || "").trim();
    if (!t) return Promise.resolve(text || "");
    if (t.length <= 800) return translateToFrenchCached(t);

    var key = cacheKey("fr", t);
    if (translationCache[key]) return Promise.resolve(translationCache[key]);

    var chunks = chunkText(t, 600);
    var promises = chunks.map(function (c) {
      if (!c) return Promise.resolve("");
      return translateToFrenchCached(c);
    });

    return Promise.all(promises).then(function (parts) {
      var joined = (parts || []).filter(Boolean).join(" ").trim();
      translationCache[key] = joined || t;
      return translationCache[key];
    });
  }

  function fallbackTranslateDomToFrench() {
    if (!document.body) return;
    // If fallback is already active (e.g. due to dynamic DOM updates), reuse the current run id
    // so we don't constantly cancel in-flight translations.
    var runId = fallbackRunId;
    if (!fallbackActive) {
      fallbackActive = true;
      runId = ++fallbackRunId;
    }

    // Translate text nodes.
    var nodes = collectTextNodes();
    var idx = 0;
    var inFlight = 0;

    function nextText() {
      if (!fallbackActive || runId !== fallbackRunId) return;
      while (inFlight < FALLBACK_CONCURRENCY && idx < nodes.length) {
        (function (node) {
          inFlight++;
          var currentRaw = node.nodeValue || "";
          rememberOriginalText(node);
          var originalRaw =
            canUseWeakMap() && originalTextByNode.has(node) ? originalTextByNode.get(node) : currentRaw;
          var source = (originalRaw || "").trim();
          if (!source) {
            inFlight--;
            return nextText();
          }

          translateLongToFrench(source).then(function (translated) {
            if (!fallbackActive || runId !== fallbackRunId) return;
            var safe = translated || source;
            // Always translate from the original English to keep results stable and avoid
            // repeatedly translating already-translated French during DOM refresh passes.
            node.nodeValue = (originalRaw || currentRaw).replace(source, safe);
          }).finally(function () {
            inFlight--;
            nextText();
          });
        })(nodes[idx++]);
      }
    }

    nextText();

    // Translate common attributes.
    var targets = collectAttributeTargets();
    targets.els.forEach(function (el) {
      if (!fallbackActive || runId !== fallbackRunId) return;
      // Skip elements already processed.
      if (el.getAttribute("data-lcp-attribs")) return;
      var savedPairs = [];
      targets.attrs.forEach(function (attr) {
        var val = el.getAttribute(attr);
        if (!val) return;
        var trimmed = (val || "").trim();
        if (!trimmed || trimmed.length < 2) return;

        // Save original once (so we can restore on EN).
        savedPairs.push(attr + "=" + val);
        translateLongToFrench(trimmed).then(function (translated) {
          if (!fallbackActive || runId !== fallbackRunId) return;
          el.setAttribute(attr, translated || trimmed);
        });
      });

      if (savedPairs.length) {
        // Store originals in a light-weight attribute (avoids keeping hard references forever).
        // We don't escape '=' or '|' because these attributes rarely contain them; if they do,
        // the translation still works, but restore might be imperfect for that element.
        if (!el.getAttribute("data-lcp-attribs")) {
          el.setAttribute("data-lcp-attribs", savedPairs.join("|"));
        }
      }
    });

    // Keep translating newly added DOM (common with page builders / SPA-like behavior).
    if (!fallbackObserver && typeof MutationObserver !== "undefined") {
      var debounceTimer = null;
      fallbackObserver = new MutationObserver(function () {
        if (!fallbackActive || runId !== fallbackRunId) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function () {
          if (!fallbackActive || runId !== fallbackRunId) return;
          fallbackTranslateDomToFrench();
        }, 600);
      });
      try {
        fallbackObserver.observe(document.body, { childList: true, subtree: true });
      } catch (e) {}
    }
  }

  function forceNoTopBar() {
    var topSelectors = [
      "iframe.goog-te-banner-frame",
      ".goog-te-banner-frame",
      "#goog-gt-tt",
      ".goog-te-balloon-frame",
      ".goog-te-ftab"
    ];

    topSelectors.forEach(function (selector) {
      var nodes = document.querySelectorAll(selector);
      nodes.forEach(function (node) {
        node.style.display = "none";
      });
    });

    if (document.body) {
      document.body.style.top = "0px";
      document.body.style.position = "static";
    }
    document.documentElement.style.top = "0px";
  }

  function watchTopBar() {
    forceNoTopBar();
    var observer = new MutationObserver(forceNoTopBar);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"]
    });
    setTimeout(function () {
      observer.disconnect();
    }, 20000);
  }

  function flagFor(lang) {
    return lang === "fr" ? "\uD83C\uDDEB\uD83C\uDDF7" : "\uD83C\uDDFA\uD83C\uDDF8";
  }

  function rewriteInternalLinksForLang(lang) {
    var home = normalizedHomePath();
    var anchors = document.querySelectorAll("a[href]");
    anchors.forEach(function (a) {
      var href = a.getAttribute("href") || "";
      if (!href || href.charAt(0) === "#") return;
      if (/^(mailto|tel|javascript):/i.test(href)) return;

      var url;
      try {
        url = new URL(href, window.location.href);
      } catch (e) {
        return;
      }

      if (url.origin !== window.location.origin) return;

      var path = url.pathname || "/";
      if (home !== "/" && path !== home && path.indexOf(home + "/") !== 0) return;
      if (home !== "/" && path === home) {
        url.pathname = home + "/";
        a.setAttribute("href", url.toString());
        return;
      }

      var rel = stripHomePath(path);
      rel = rel.replace(/^\/(en|fr)(\/|$)/i, "/");
      rel = "/" + rel.replace(/^\/+/, "");
      rel = rel === "/" ? "/" : rel.replace(/\/+$/, "") + "/";

      if (rel === "/") {
        url.pathname = home === "/" ? "/" : home + "/";
      } else {
        var base = home === "/" ? "" : home;
        url.pathname = base + "/" + lang + rel;
      }

      a.setAttribute("href", url.toString());
    });
  }

  function activateLang(lang) {
    setLangCookie(lang);
    rewriteInternalLinksForLang(lang);
    if (lang === "fr") {
      setGoogleCookie("fr");
      applyComboLang("fr", 0);
      // If Google widget is blocked (very common), start fallback sooner.
      setTimeout(function () {
        if (!getCombo() && !isGoogleTranslated()) {
          fallbackTranslateDomToFrench();
        }
      }, 1500);

      // If Google widget fails (blocked/optimization conflict), fallback to free API translation.
      setTimeout(function () {
        // Give Google Translate a bit more time on heavy pages.
        if (!isGoogleTranslated()) {
          fallbackTranslateDomToFrench();
        }
      }, 6500);
    } else {
      // Restore original English if we used the fallback translator.
      revertFallbackToEnglish();
      clearGoogleCookie();
      setGoogleCookie("en");
      applyComboLang("en", 0);
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    var currentLang = resolveInitialLang();

    var wrap = document.querySelector(".lcp-switcher");
    var trigger = document.getElementById("lcp-lang-trigger");
    var menu = document.getElementById("lcp-lang-menu");
    var currentFlag = document.getElementById("lcp-current-flag");
    var items = menu ? menu.querySelectorAll(".lcp-item") : [];

    activateLang(currentLang);
    watchTopBar();

    if (!trigger || !menu) return;

    trigger.setAttribute("data-lang", currentLang);
    if (currentFlag) currentFlag.textContent = flagFor(currentLang);

    function closeMenu() {
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
    }

    function openMenu() {
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
    }

    trigger.addEventListener("click", function () {
      if (menu.hidden) openMenu();
      else closeMenu();
    });

    document.addEventListener("click", function (event) {
      if (!wrap || !wrap.contains(event.target)) closeMenu();
    });

    items.forEach(function (item) {
      item.addEventListener("click", function () {
        var lang = item.getAttribute("data-lang") === "fr" ? "fr" : "en";
        var targetUrl = item.getAttribute("data-url") || "";
        var currentUrl = window.location.href.replace(/\/+$/, "");
        var normalizedTarget = targetUrl.replace(/\/+$/, "");

        activateLang(lang);
        if (currentFlag) currentFlag.textContent = flagFor(lang);
        trigger.setAttribute("data-lang", lang);
        closeMenu();

        // Google Translate applies reliably after navigation/reload.
        if (normalizedTarget && normalizedTarget !== currentUrl) {
          window.location.href = targetUrl;
          return;
        }

        window.location.reload();
      });
    });
  });
})();
