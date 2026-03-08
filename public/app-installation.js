(function () {
  'use strict';

  // Om APK inte finns på servern, visa en förklaring under knappen
  var link = document.getElementById('app-download-android');
  var unavailable = document.getElementById('app-android-unavailable');
  if (link && unavailable) {
    fetch('/downloads/f1tting.apk', { method: 'HEAD' })
      .then(function (res) {
        if (!res.ok) {
          unavailable.classList.remove('hidden');
        }
      })
      .catch(function () {
        unavailable.classList.remove('hidden');
      });
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }
})();
