# tacilytics (Flutter)

Privacy-first, cookieless app analytics for [Tacilytics](https://github.com/Open-Cosmic-Software/tacilytics).
Screen views, goals, in-app search and revenue land in the same dashboard as your website, filterable by platform.

- **Off by default.** Nothing is sent until `setEnabled(true)`, so you can wire it to your consent.
- **No device id, no advertising id, no cookies.** One random id per app launch, kept in memory only.
- **Fire-and-forget.** Never throws into your app, never blocks the UI.

```yaml
dependencies:
  tacilytics:
    git:
      url: https://github.com/Open-Cosmic-Software/tacilytics
      path: sdk/flutter
```

```dart
void main() {
  Tacilytics.init(endpoint: 'https://analytics.example.com', domain: 'example.com', appVersion: '1.4.0');
  runApp(MaterialApp(navigatorObservers: [TacilyticsRouteObserver()], home: const Home()));
}

// after your consent dialog
Tacilytics.instance.setEnabled(accepted);

Tacilytics.instance.screen('/product/42');            // manual screen view
Tacilytics.instance.event('Signup', {'plan': 'pro'});  // goal with properties
Tacilytics.instance.search('vinegar', 6);              // 0 results show up under "No results"
Tacilytics.instance.purchase(value: 49.90, items: 2);  // revenue — never pass customer data
Tacilytics.instance.setCampaign(source: 'newsletter'); // e.g. from a deep link
```

Use the same `domain` as your website to see web and app side by side. On Flutter web the client stays silent; use the `tacilytics.js` tag there.

Tests: `flutter test` (unit) · `TACILYTICS_E2E=http://localhost:3920 flutter test --tags e2e --run-skipped` (against a running server).

MIT licensed.

## Upgrading from `nyx_analytics`
Rename the dependency to `tacilytics` and import `package:tacilytics/tacilytics.dart`. If you can't change your code yet, import `package:tacilytics/nyx_analytics.dart`: `NyxAnalytics`, `NyxBeacon` and `NyxRouteObserver` still work as deprecated aliases.
