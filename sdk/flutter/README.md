# nyx_analytics (Flutter) 🦞

Privacy-first, cookieless app analytics for [Nyx Analytics](https://github.com/Open-Cosmic-Software/nyx-analytics).
Screen views, goals, in-app search and revenue land in the same dashboard as your website, filterable by platform.

- **Off by default.** Nothing is sent until `setEnabled(true)`, so you can wire it to your consent.
- **No device id, no advertising id, no cookies.** One random id per app launch, kept in memory only.
- **Fire-and-forget.** Never throws into your app, never blocks the UI.

```yaml
dependencies:
  nyx_analytics:
    git:
      url: https://github.com/Open-Cosmic-Software/nyx-analytics
      path: sdk/flutter
```

```dart
void main() {
  NyxAnalytics.init(endpoint: 'https://analytics.example.com', domain: 'example.com', appVersion: '1.4.0');
  runApp(MaterialApp(navigatorObservers: [NyxRouteObserver()], home: const Home()));
}

// after your consent dialog
NyxAnalytics.instance.setEnabled(accepted);

NyxAnalytics.instance.screen('/product/42');            // manual screen view
NyxAnalytics.instance.event('Signup', {'plan': 'pro'});  // goal with properties
NyxAnalytics.instance.search('vinegar', 6);              // 0 results show up under "No results"
NyxAnalytics.instance.purchase(value: 49.90, items: 2);  // revenue — never pass customer data
NyxAnalytics.instance.setCampaign(source: 'newsletter'); // e.g. from a deep link
```

Use the same `domain` as your website to see web and app side by side. On Flutter web the client stays silent; use the `nyx.js` tag there.

Tests: `flutter test` (unit) · `NYX_E2E=http://localhost:3920 flutter test --tags e2e --run-skipped` (against a running server).

MIT licensed.
