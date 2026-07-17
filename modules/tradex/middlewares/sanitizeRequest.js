const escapeHtml = (value) => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

const sanitizeRequest = (req, res, next) => {

  const sanitizeObject = (obj) => {
    if (!obj || typeof obj !== "object") {
      return;
    }

    if (Array.isArray(obj)) {
      obj.forEach((item, index) => {
        if (typeof item === "string") {
          obj[index] = escapeHtml(item);
          return;
        }

        sanitizeObject(item);
      });
      return;
    }

    for (let key in obj) {

      if (typeof obj[key] === "string") {

        obj[key] = escapeHtml(obj[key]);

      }

      if (obj[key] && typeof obj[key] === "object") {

        sanitizeObject(obj[key]);

      }

    }

  };

  sanitizeObject(req.body);

  next();

};

export default sanitizeRequest;
