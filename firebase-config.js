/* ここは「本番モード」（インターネット越しに東京⇔現地で使う）の設定置き場。
   設定のやり方は README.md の「本番セットアップ」を見てください。

   null のままなら、テストモード（dev-server.js 経由・同じWi-Fi内のみ）で動きます。

   Firebaseの設定を貼るときは、null を消して次のような形にします:

   window.FIREBASE_CONFIG = {
     apiKey: "AIza....",
     authDomain: "xxxx.firebaseapp.com",
     databaseURL: "https://xxxx-default-rtdb.asia-southeast1.firebasedatabase.app",
     projectId: "xxxx",
     storageBucket: "xxxx.appspot.com",
     messagingSenderId: "0000000000",
     appId: "1:0000000000:web:xxxxxxxx"
   };
*/
window.FIREBASE_CONFIG = null;
