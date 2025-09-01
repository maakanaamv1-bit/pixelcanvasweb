<<<<<<< HEAD
PixelCanvas Full – Views Folder
================================

📂 Purpose:
------------
This folder contains all **server-rendered templates** (HTML, EJS, or Handlebars) that the Express server
uses to generate pages. Unlike the /public directory (which serves static files such as JS, CSS, images),
the /views directory is intended for dynamic templates rendered on the server side.

🛠️ Typical Usage:
------------------
- Login pages
- Error pages (404, 500, banned user, etc.)
- Admin dashboards
- Profile or leaderboard pages (if not fully client-side)

📌 Notes:
---------
1. The project currently uses mostly REST APIs + Firebase client SDK for front-end rendering,
   but this folder is provided for flexibility if you need server-side rendering later.
   
2. By default, Express is configured to look here for `.ejs` or `.html` templates if you set:
     app.set('views', path.join(__dirname, 'views'));
     app.set('view engine', 'ejs');

3. If you don’t plan to use server-rendered templates, this folder can remain empty.

✅ Best Practice:
-----------------
- Use /public for static HTML (chat.html, index.html, etc.)
- Use /views for dynamic pages that need server-side variables (e.g., admin.ejs)
- Keep error pages in /views/errors/ for cleaner structure

Example structure:
  views/
    errors/
      404.ejs
      500.ejs
    admin/
      dashboard.ejs
    readme.txt   <-- (this file)

=======
PixelCanvas Full – Views Folder
================================

📂 Purpose:
------------
This folder contains all **server-rendered templates** (HTML, EJS, or Handlebars) that the Express server
uses to generate pages. Unlike the /public directory (which serves static files such as JS, CSS, images),
the /views directory is intended for dynamic templates rendered on the server side.

🛠️ Typical Usage:
------------------
- Login pages
- Error pages (404, 500, banned user, etc.)
- Admin dashboards
- Profile or leaderboard pages (if not fully client-side)

📌 Notes:
---------
1. The project currently uses mostly REST APIs + Firebase client SDK for front-end rendering,
   but this folder is provided for flexibility if you need server-side rendering later.
   
2. By default, Express is configured to look here for `.ejs` or `.html` templates if you set:
     app.set('views', path.join(__dirname, 'views'));
     app.set('view engine', 'ejs');

3. If you don’t plan to use server-rendered templates, this folder can remain empty.

✅ Best Practice:
-----------------
- Use /public for static HTML (chat.html, index.html, etc.)
- Use /views for dynamic pages that need server-side variables (e.g., admin.ejs)
- Keep error pages in /views/errors/ for cleaner structure

Example structure:
  views/
    errors/
      404.ejs
      500.ejs
    admin/
      dashboard.ejs
    readme.txt   <-- (this file)

>>>>>>> e07027fe (Add compression to dependencies)
