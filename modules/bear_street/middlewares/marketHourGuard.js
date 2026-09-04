const marketHoursGuard = (req, res, next) => {
  const now = new Date();

  // Convert to IST
  const istTime = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );

  const day = istTime.getDay();   // 0 = Sunday, 6 = Saturday
  const hours = istTime.getHours();
  const minutes = istTime.getMinutes();

  // ❌ Block weekends
  if (day === 0 || day === 6) {
    return res.status(400).json({
      success: false,
      message: "Market is closed (Weekend)."
    });
  }

  const totalMinutes = hours * 60 + minutes;
  const marketOpen = 9 * 60 + 15;   // 9:15 AM
  const marketClose = 15 * 60 + 30; // 3:30 PM

  // ❌ Block before 9:15 AM
  if (totalMinutes < marketOpen) {
    return res.status(400).json({
      success: false,
      message: "Market has not opened yet (opens at 9:15 AM IST)."
    });
  }

  // ❌ Block after 3:30 PM
  if (totalMinutes >= marketClose) {
    return res.status(400).json({
      success: false,
      message: "Market is closed (after 3:30 PM IST)."
    });
  }

  // ✅ Allowed between 9:15–3:29:59
  next();
};

export default marketHoursGuard;
