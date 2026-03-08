'use strict';
var fs = require('fs');
var path = require('path');

var repoRoot = path.join(__dirname, '..');
var sdk = process.env.ANDROID_HOME || path.join(process.env.HOME || '', 'Library', 'Android', 'sdk');
sdk = sdk.replace(/\\/g, '/');

var localProps = path.join(repoRoot, 'android', 'local.properties');
var content = 'sdk.dir=' + sdk + '\n';

if (!fs.existsSync(sdk)) {
  console.error('Android SDK hittas inte: ' + sdk);
  console.error('Installera Android Studio eller command line tools och sätt ANDROID_HOME till SDK-mappen.');
  process.exit(1);
}

fs.writeFileSync(localProps, content);
console.log('Skrev sdk.dir till android/local.properties: ' + sdk);

// Skriv org.gradle.java.home så Gradle använder Java 17 även om shell har annan JAVA_HOME
var javaHome = process.env.JAVA_HOME;
if (javaHome) {
  javaHome = javaHome.replace(/\\/g, '/');
  var gradlePropsPath = path.join(repoRoot, 'android', 'gradle.properties');
  var gradleProps = fs.existsSync(gradlePropsPath) ? fs.readFileSync(gradlePropsPath, 'utf8') : '';
  var line = 'org.gradle.java.home=' + javaHome + '\n';
  if (/org\.gradle\.java\.home=/.test(gradleProps)) {
    gradleProps = gradleProps.replace(/org\.gradle\.java\.home=.*/g, 'org.gradle.java.home=' + javaHome);
  } else {
    gradleProps = gradleProps.trimEnd() + '\n' + line;
  }
  fs.writeFileSync(gradlePropsPath, gradleProps);
  console.log('Skrev org.gradle.java.home till android/gradle.properties');
}
