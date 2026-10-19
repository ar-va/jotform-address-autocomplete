# Jotform Address Autocomplete Widget

A Jotform custom widget that finds addresses as you type (Google Places) and then splits the chosen address into standard fields: Street Address, Line 2, City, Province / State, Postal / Zip Code, and Country. It runs on Cloudflare Workers, which also calls Google on the widget's behalf, so **your Google API key never reaches the browser**.

<img src="docs/screenshot.png" alt="Address search with suggestions grouped by country, above the filled-in address fields" width="560">

## Features

- One search bar with suggestions from your home country first, then other countries.
- Picking a suggestion fills editable fields laid out like Jotform's built-in Address field. A "Can't find it? Enter address manually" link covers addresses Google doesn't know.
- Colours, font, sizes and labels are set from Jotform widget parameters, with no code changes. A `customCSS` parameter covers anything else.
- The Google key is stored as a Cloudflare secret. The widget page and its lookup API only respond inside a Jotform iframe.
- Saved submissions are readable text and load back into the fields when a submission is edited:

  ```
  Street Address: 219 Dufferin Street
  Street Address Line 2: Unit 5
  City: Guelph
  Province / State: Ontario
  Postal / Zip Code: N1H 4A9
  Country: Canada
  ```

## How it works

```
Jotform form ──iframe──▶ your-domain/            widget page (public/index.html)
                              │
                              └─ fetch ──▶ your-domain/api/suggest   ─┐
                                           your-domain/api/place     ─┴─▶ Google Places API (New)
                                           (Cloudflare Worker, src/index.ts, holds the key)
```

## Setup

You need:

- A Cloudflare account with a domain on it, for example `address.example.com`.
- A Google Cloud project with **billing enabled** and **Places API (New)** enabled.
- Node.js 22.18 or later, and the [Cloudflare CLI](https://developers.cloudflare.com/cf/) (`npm install --global cf`, then `cf auth login`).

### 1. Get the code

```sh
git clone https://github.com/ar-va/jotform-address-autocomplete-google-maps.git
cd jotform-address-autocomplete-google-maps
npm install
```

### 2. Configure

In `cloudflare.config.ts`:

- `name`: any Worker name.
- `domains`: the address Jotform will load the widget from, on a domain in your Cloudflare account.
- `PRIMARY_COUNTRY`: two-letter country code listed first in suggestions (default `ca`).

In `src/index.ts`, `ALLOWED_HOSTS` lists the sites allowed to embed the widget. The default `jotform.com` covers `form.jotform.com`, `eu.jotform.com` and the form builder. Add your own domain if your forms use a Jotform custom domain.

### 3. Create a Google key for the server

In Google Cloud → APIs & Services → Credentials, create an API key:

- **API restrictions:** Places API (New) only.
- **Application restrictions:** None. The key is used from Cloudflare's servers, which have no fixed IP or website to restrict to. It's never sent to browsers.
- Recommended: set a daily request cap under Places API (New) → Quotas, so unexpected traffic can't run up a bill.

Copy `.dev.vars.example` to `.dev.vars` and paste the key in. `.dev.vars` is git-ignored; never commit it.

### 4. Deploy

```sh
cf deploy --secrets-file .dev.vars
```

This uploads the widget and the Worker, stores the key as a Cloudflare secret, and serves it on your domain. Later deploys can run plain `cf deploy` unless the key changes.

Opening the URL directly in a browser shows **Forbidden**. That's expected; it only loads inside a Jotform form.

### 5. Add it to Jotform

Create a custom widget in Jotform's widget developer area, set its URL to your domain (`https://address.example.com/`), and add it to a form. Add any of the optional parameters below as user parameters.

## Widget parameters

All parameters are optional. Leave one out or blank to keep the default. Sizes take a plain number (pixels) or any CSS length.

| Parameter | What it changes | Default |
| --- | --- | --- |
| `accentColor` | Focus outline, links | `#2e69ff` |
| `textColor` | Typed text | `#2c3345` |
| `labelColor` | Small labels under fields, hints | `#6c7389` |
| `borderColor` | Field borders | `#c3cad8` |
| `fieldBackground` | Field and dropdown background | `#ffffff` |
| `highlightColor` | Highlighted suggestion | `#eef3ff` |
| `fontFamily` | Font | Inter, system font |
| `fontSize` | Text size | `15` |
| `fieldHeight` | Field height | `40` |
| `cornerRadius` | Field corner rounding | `4` |
| `searchPlaceholder` | Search bar hint | Search for your address |
| `manualLinkText` | Manual-entry link | Can't find it? Enter address manually |
| `labelStreet`, `labelLine2`, `labelCity`, `labelProvince`, `labelPostal`, `labelCountry` | Field labels. These also name the lines in the submitted value. | Street Address, … |
| `customCSS` | Extra CSS added to the widget, e.g. `.field label { font-weight: 600 }` | empty |

The widget can't read your form's theme automatically (browsers keep an iframe from another site apart from the page around it), so set the colours to match your form's Form Designer.

## Local development

```sh
cf dev
```

The widget page still returns Forbidden when opened directly. To call the API locally, send `Sec-Fetch-Site: same-origin`, for example:

```sh
curl -H 'Sec-Fetch-Site: same-origin' 'http://localhost:5173/api/suggest?q=219+dufferin&session=11111111-2222-4333-8444-555555555555'
```

Google errors are logged by the Worker (`Google Places … failed: <status> <message>`). After deploying, view them in the Cloudflare dashboard under the Worker's logs.

## Limits

- The iframe and same-origin checks stop casual use and stop other websites from embedding the widget. Request headers can be faked by scripts, though, and any Jotform account that knows your URL could embed it. Keep the Google quota cap in place.
- Google requires the "Powered by Google" note in the suggestion list. Keep it.

## License

[MIT](LICENSE)
