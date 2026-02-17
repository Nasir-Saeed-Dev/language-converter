# Language Converter (EN/FR)

Author: Nasir Saeed
Author URL: https://nasir-saeed-dev.netlify.app/

## Features
- Flag-only language dropdown shortcode for header placement.
- Uses Google-Translate-style frontend translation (same approach as google-language-translator plugin family): translate rendered page DOM instead of rewriting post content in PHP.
- Default language is English.
- Adds `en` or `fr` prefix for inner pages.
- Keeps home page URL clean with no query param.

## Folder Structure
```text
language-converter-plugin/
  language-converter-plugin.php
  README.md
  includes/
    class-lcp-core.php
  assets/
    css/
      lcp-style.css
    js/
      lcp-switcher.js
```

## Installation
1. Copy `language-converter-plugin` folder into `wp-content/plugins/`.
2. Activate **Language Converter** from WordPress Admin > Plugins.
3. Go to **Settings > Permalinks** and click **Save Changes** once.

## How to Use
1. Add shortcode in header/template: `[lcp_language_switcher]`
2. Use flags in dropdown:
   - ???? English (default)
   - ???? French

## URL Behavior
- Home page:
  - `https://example.com/` for both languages
- Inner pages:
  - English: `https://example.com/en/about-us/`
  - French: `https://example.com/fr/about-us/`

