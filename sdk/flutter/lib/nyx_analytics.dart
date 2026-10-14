/// Deprecated entry point from before the rename to Tacilytics.
/// Import `package:tacilytics/tacilytics.dart` instead; these aliases will be removed in a later major version.
library nyx_analytics;

import 'tacilytics.dart';
export 'tacilytics.dart';

@Deprecated('Use Tacilytics')
typedef NyxAnalytics = Tacilytics;
@Deprecated('Use TacilyticsBeacon')
typedef NyxBeacon = TacilyticsBeacon;
@Deprecated('Use TacilyticsRouteObserver')
typedef NyxRouteObserver = TacilyticsRouteObserver;
