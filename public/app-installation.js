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

  var iosLink = document.getElementById('app-download-ios');
  var iosUnavailable = document.getElementById('app-ios-unavailable');
  if (iosLink && iosUnavailable) {
    fetch('/downloads/f1_bet.ipa', { method: 'HEAD' })
      .then(function (res) {
        if (!res.ok) {
          iosUnavailable.classList.remove('hidden');
        }
      })
      .catch(function () {
        iosUnavailable.classList.remove('hidden');
      });
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }
})();
