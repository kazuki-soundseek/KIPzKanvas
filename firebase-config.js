/* 本番モード（インターネット越し）の設定。2026-08-02 に自動セットアップ済み。
   この設定が入っていると、アプリはFirebase経由で動く（dev-server.js は不要になる）。
   テストモード（同じWi-Fi内・dev-server.js）に戻したいときは、下を null にする。 */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyDJhl1aPzrISXSf0DV-wCZhzJKvCZbd_lo",
  authDomain: "kipz-kanvas-45fa6.firebaseapp.com",
  databaseURL: "https://kipz-kanvas-45fa6-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "kipz-kanvas-45fa6",
  storageBucket: "kipz-kanvas-45fa6.firebasestorage.app",
  messagingSenderId: "759092413253",
  appId: "1:759092413253:web:d85ef9f5e9f32f6146b42c"
};
