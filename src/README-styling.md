# Frontend Editing Cheat Sheet

This guide is for quick edits when you see something on the website and want to know where to change it.

Think of the frontend like this:

- `index.html` = what exists on the page
- `src/styles/*.css` = how it looks
- `src/main.js` = what it does

## Fast Workflow

1. Find visible text on the website.
2. Search for that text in `index.html` or `src/main.js`.
3. Look for the nearby `class` or `id`.
4. Search that class or id in the CSS files.

Example:

- Website text: `Get Started`
- HTML element: `welcome-start-btn`
- CSS selector to edit: `.welcome-start-btn`
- Main file: `src/styles/base.css`

## CSS File Map

- `src/styles/base.css`
  Controls shared styles, welcome screen, top header, bottom nav, fonts, colors, spacing.
- `src/styles/pick.css`
  Controls the main home/logging screen with the competition card and `INSERT OIS`.
- `src/styles/dashboard.css`
  Controls the player dashboard with stats and log history.
- `src/styles/board.css`
  Controls the leaderboard screen.
- `src/styles/admin.css`
  Controls the PIN screen and admin area.
- `src/styles/modals.css`
  Controls popups like `Competition Rules`.
- `src/styles/shared.css`
  Controls shared pieces like avatars, toast messages, and utility classes.
- `src/styles/responsive.css`
  Controls phone/tablet size adjustments.
- `src/styles/theme-arcade.css`
  Re-skins the app into the arcade theme. If a normal style is not showing, check here last because it can override other files.

## Common Changes

### Change the main app colors

- Edit file: `src/styles/base.css`
- Search for: `:root`
- Change variables like:
  - `--accent`
  - `--accent2`
  - `--bg`
  - `--surface`
  - `--text`

Website examples:

- Blue buttons
- Background colors
- Text colors

Important:

- If your color change does not show up, also check `src/styles/theme-arcade.css` because it overrides many base colors.

### Change fonts across the website

- Edit file: `src/styles/base.css`
- Search for:
  - `--type-display-family`
  - `--type-heading-family`
  - `--type-body-family`

Website examples:

- Big titles like `Wiregrass OIS Competition`
- Body text like helper copy and labels

### Change the welcome screen

- Edit file: `src/styles/base.css`
- Search for:
  - `.welcome-screen`
  - `.welcome-inner`
  - `.welcome-title`
  - `.welcome-copy`
  - `.welcome-start-btn`

Website examples:

- `Wiregrass OIS Competition`
- `Get Started`

### Change the top header

- Edit file: `src/styles/base.css`
- Search for:
  - `.app-header`
  - `.dash-name`
  - `.dash-comp-badge`

Website example:

- The thin top bar that shows the player name and competition name

### Change the bottom navigation

- Edit file: `src/styles/base.css`
- Search for:
  - `.bottom-nav`
  - `.nav-btn`
  - `.nav-label`

Website examples:

- `Maze`
- `Leaderboard`
- `WIREGRASS HQ`

### Change the main competition card

- Edit file: `src/styles/pick.css`
- Search for:
  - `.pick-comp-info`
  - `.pick-comp-name`
  - `.pick-comp-dates`
  - `.pick-countdown`

Website examples:

- Competition title
- `DAYS LEFT`

### Change the player picker area

- Edit file: `src/styles/pick.css`
- Search for:
  - `.pick-emp-selector`
  - `.pick-emp-grid`
  - `.name-btn`
  - `#pick-emp-list`

Website examples:

- `Choose player...`
- The list of employee/player names

### Change the Sales and Hours inputs

- Edit file: `src/styles/pick.css`
- Search for:
  - `.log-input`
  - `.field-label`
  - `.log-fields`

Website examples:

- `SALES($)`
- `HOURS WORKED`

### Change the Add OIS button

- Edit file: `src/styles/pick.css`
- Search for: `.log-btn`

Website example:

- `ADD OIS`

Important:

- This same button style is reused in more than one place.
- If you only want one button changed, find its HTML `id` in `index.html` or `src/main.js`.

### Change the success message after logging

- Edit file: `src/styles/pick.css`
- Search for:
  - `.pick-success-state`
  - `.pick-success-title`
  - `.pick-success-cta`

Website examples:

- `LOGGED!`
- `VIEW LEADERBOARD →`

### Change dashboard stat cards

- Edit file: `src/styles/dashboard.css`
- Search for:
  - `.stat-row`
  - `.stat-card`
  - `.stat-label`
  - `.stat-value`

Website examples:

- `SALES / HR`
- `TOTAL SALES`
- `RANK`

### Change the dashboard message row

- Edit file: `src/styles/dashboard.css`
- Search for:
  - `.vibe-card`
  - `#vibe-emoji`

Website example:

- The row with the flame emoji and message text

### Change the Orders list

- Edit file: `src/styles/dashboard.css`
- Search for:
  - `.history-wrap`
  - `.history-title`
  - `.history-item`

Website example:

- `ORDERS`

### Change the leaderboard cards

- Edit file: `src/styles/board.css`
- Search for:
  - `.board-card`
  - `.board-rank`
  - `.board-name`
  - `.board-sph`

Website examples:

- Ranked player rows
- First-place gold-styled card

### Change the leaderboard competition dropdown

- Edit file: `src/styles/board.css`
- Search for:
  - `.comp-select`
  - `.board-comp-menu`
  - `.board-comp-option`

Website example:

- The `Select...` control at the top of the leaderboard

### Change the admin PIN screen

- Edit file: `src/styles/admin.css`
- Search for:
  - `.admin-gate-body`
  - `.admin-gate-title`
  - `#input-pin`
  - `.pin-error`

Website examples:

- `MANAGER GATE`
- `OPEN GATE`

### Change admin tabs and admin rows

- Edit file: `src/styles/admin.css`
- Search for:
  - `.admin-tab-bar`
  - `.admin-tab-btn`
  - `.admin-item`
  - `.admin-item-name`

Website examples:

- The admin section tab buttons
- The list rows inside admin

### Change the rules popup

- Edit file: `src/styles/modals.css`
- Search for:
  - `.info-modal`
  - `.info-modal-content`
  - `.info-modal-title`
  - `.info-modal-body`

Website example:

- Popup titled `Competition Rules`

### Change avatars or player image styling

- Edit file: `src/styles/shared.css`
- Search for:
  - `.avatar`
  - `.avatar-img`
  - `.avatar-placeholder`

Website examples:

- Player profile picture
- First-letter fallback icon

### Change the floating toast message

- Edit file: `src/styles/shared.css`
- Search for: `.toast`

Website example:

- The small floating message near the bottom of the screen

### Change the mobile version

- Edit file: `src/styles/responsive.css`
- Search for:
  - `@media (max-width: 640px)`
  - `@media (max-width: 380px)`
  - `@media (max-width: 720px)`

Website examples:

- Phone layout
- Smaller buttons
- Stacked cards

### Change the arcade look specifically

- Edit file: `src/styles/theme-arcade.css`
- Search for:
  - `:root`
  - `.app-header`
  - `.bottom-nav`
  - `.log-btn`
  - `.pick-info-btn`

Website examples:

- Pixel fonts
- Dark retro background
- Chunky arcade button borders

Important:

- This file is loaded last.
- If a style seems to "ignore" your change in another CSS file, the arcade theme may be overriding it here.

## If You Want To Change Text Instead Of Style

Use `index.html` or `src/main.js`.

Examples:

- Change `Get Started`
  - Search in `index.html`
- Change `Competition Rules`
  - Search in `index.html`
- Change button behavior or screen switching
  - Search in `src/main.js`

## Selector Reading Guide

These are the most common selector types you will see:

- `.something`
  - A class. Reusable style.
  - Example: `.log-btn`
- `#something`
  - A specific unique element.
  - Example: `#input-pin`
- `:root`
  - Global variables for colors, fonts, spacing.
- `@media (...)`
  - Rules that only apply on certain screen sizes.

## Safe Editing Tips

- Change one thing at a time.
- Save and refresh after each small edit.
- If you are changing colors or fonts and nothing happens, check `src/styles/theme-arcade.css`.
- If you want to understand what a selector affects, use the browser inspect tool and look for the matching `class` or `id`.

## Best Places To Start

If you are unsure where to look:

- Colors/fonts/layout across whole app
  - Start in `src/styles/base.css`
- Main gameplay/home screen
  - Start in `src/styles/pick.css`
- Leaderboard
  - Start in `src/styles/board.css`
- Admin area
  - Start in `src/styles/admin.css`
- Popup windows
  - Start in `src/styles/modals.css`
- Something looks wrong only on phone
  - Start in `src/styles/responsive.css`
- Normal change is being overridden
  - Check `src/styles/theme-arcade.css`
