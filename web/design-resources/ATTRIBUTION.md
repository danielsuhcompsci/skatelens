# SkateLens design resources

## Animata Fluid Tabs

The video-source control uses a local vanilla-JavaScript adaptation of **Animata Fluid Tabs**, discovered through the **Animata listing in Designeer's component catalogue**.

- Verified discovery listing: <https://designeer.xyz/resources/animata>. Its “Visit” link points to <https://animata.design/?utm_source=designeer.xyz>.
- Component documentation: <https://animata.design/docs/tabs/fluid-tabs>
- Official repository: <https://github.com/codse/animata>
- Pinned revision: `25c27e5a874c60a56dcc1609df3b2c4f5f8456f8`
- License: MIT; the complete upstream notice is in `upstream/animata/LICENSE.md`.
- Component credit in the upstream documentation: Rudra Sankha Sinhamahapatra.

### Actual source reuse and adaptation

`fluid-tabs.mjs` and `fluid-tabs.css` adapt the sliding selected surface, selected-label scale, original spring values (`stiffness: 380`, `damping: 34`, `mass: 0.75`), original label transition, and keyboard handling from these pinned upstream files:

- <https://github.com/codse/animata/blob/25c27e5a874c60a56dcc1609df3b2c4f5f8456f8/animata/tabs/fluid-tabs.tsx>
- <https://github.com/codse/animata/blob/25c27e5a874c60a56dcc1609df3b2c4f5f8456f8/animata/tabs/shared.ts>

Unmodified copies are retained under `upstream/animata/` for review and license provenance. The application loads only the local `.mjs` and `.css` adaptation. React, Tailwind and Motion are replaced by the existing HTML controls, CSS, browser-native animation and DOM observers. The adaptation keeps application selection in the existing click handlers, adds roving focus, skips disabled tabs, and respects reduced-motion preferences. SkateLens supplies the palette, radius, layout and copy.

This is component source adaptation, not a claim that Designeer authored the component. Designeer is the discovery catalogue. The overall application design is original to SkateLens.

### Integration

Load `/design-resources/fluid-tabs.css` after the application stylesheet. Keep `role="tablist"`, `role="tab"`, and `aria-selected` on the existing source controls.

```js
import { enhanceFluidTabs } from './design-resources/fluid-tabs.mjs';
enhanceFluidTabs(document.querySelector('.tabs[role="tablist"]'));
```

Application click handlers continue to update `aria-selected`. The component observes those changes. Arrow keys, Home and End move focus; Enter or Space activates the focused tab. The list supports `--fluid-tab-surface`, `--fluid-tab-radius`, `--fluid-tab-shadow`, and `--fluid-tab-focus` for local visual styling.

SkateLens uses system fonts in its original dark-and-green interface.
