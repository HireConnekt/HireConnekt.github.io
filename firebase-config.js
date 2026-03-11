const firebaseConfig = {
  apiKey: "AIzaSyCbzWTVMUZNHYSDfOczperX0TWAe4iv_2A",
  authDomain: "hireconnect-54cf4.firebaseapp.com",
  projectId: "hireconnect-54cf4",
  storageBucket: "hireconnect-54cf4.firebasestorage.app",
  messagingSenderId: "1003752559397",
  appId: "1:1003752559397:web:f7abad410dcfe2896c00cc",
  measurementId: "G-JKYXC07SYB",
};

firebase.initializeApp(firebaseConfig);
const db   = firebase.firestore();
const auth = firebase.auth();
