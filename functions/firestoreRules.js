rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    ////////////////////////////
    // USERS COLLECTION
    ////////////////////////////
    match /users/{userId} {
      allow read: if true; // Anyone can view profiles

      allow create: if request.auth != null && request.auth.uid == userId;

      allow update: if request.auth != null && request.auth.uid == userId
        && request.resource.data.keys().hasOnly([
          'bio', 'avatar', 'lastActive', 'stats'
        ])
        && request.resource.data.bio.size() < 300
        && request.resource.data.avatar.matches('https?://.*');

      // Prevent clients from editing premium fields (colorPack, pixels, subscription)
      allow update: if false when request.resource.data.keys().hasAny([
        'colorPack', 'availablePixels', 'subscriptionActive', 'subscriptionStarted'
      ]);
    }

    ////////////////////////////
    // PIXELS COLLECTION
    ////////////////////////////
    match /pixels/{pixelId} {
      allow read: if true;

      allow create: if request.auth != null
        && request.resource.data.keys().hasOnly(['x','y','color','placedBy','placedAt'])
        && request.resource.data.x >= 0 && request.resource.data.x < 100
        && request.resource.data.y >= 0 && request.resource.data.y < 100
        && request.resource.data.color.matches('^#[0-9a-fA-F]{6}$')
        && request.resource.data.placedBy == request.auth.uid
        && request.resource.data.placedAt == request.time;

      // Prevent users from overwriting others’ pixels directly
      allow update: if false;

      // Allow deletes only to server/admins (optional)
      allow delete: if false;
    }

    ////////////////////////////
    // CHATS COLLECTION
    ////////////////////////////
    match /chats/{chatId} {
      allow read: if true;

      allow create: if request.auth != null
        && request.resource.data.keys().hasOnly(['text','sender','createdAt'])
        && request.resource.data.sender == request.auth.uid
        && request.resource.data.text.size() > 0
        && request.resource.data.text.size() < 500
        && request.resource.data.createdAt == request.time;

      allow update, delete: if false; // Chat messages are immutable
    }

    ////////////////////////////
    // LEADERBOARD COLLECTION
    ////////////////////////////
    match /leaderboard/{docId} {
      allow read: if true;
      allow write: if false; // server only
    }

    ////////////////////////////
    // PURCHASES COLLECTION
    ////////////////////////////
    match /purchases/{purchaseId} {
      allow read: if request.auth != null && resource.data.uid == request.auth.uid;
      allow write: if false; // only server/Stripe webhook can write
    }

    ////////////////////////////
    // ADMIN/MODERATION
    ////////////////////////////
    match /moderation/{docId} {
      allow read: if false;
      allow write: if false; // reserved for server/admin SDK
    }
  }
}
