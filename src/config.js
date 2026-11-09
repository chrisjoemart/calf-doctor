// Firebase web config for the "Calf Doctor" project.
// These values aren't secret: the Firestore security rules protect the data.
export const firebaseConfig = {
  apiKey: 'AIzaSyCLMkE4nEL-OgaJlJM0x8pgrV2V-0e3w7g',
  authDomain: 'calf-doctor.firebaseapp.com',
  projectId: 'calf-doctor',
  storageBucket: 'calf-doctor.firebasestorage.app',
  messagingSenderId: '833568656156',
  appId: '1:833568656156:web:5627b25ae5b8936e6a88d9',
};

// The owner always has admin access, even before any crew list exists.
export const OWNER_EMAILS = ['chrisjoemart@gmail.com'];
