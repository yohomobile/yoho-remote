const nodemailer = require('nodemailer');

// 邮件配置
const config = {
    host: 'smtp.feishu.cn',
    port: 465,
    secure: true,
    user: 'Marketing@yohomobile.com',
    password: 'TcfpTaIOGAz1fdP4',
    from: 'Yoho Mobile <Marketing@yohomobile.com>',
};

// 优化的购物车提醒邮件 HTML
const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your cart is waiting for you</title>
    <style>
        @media only screen and (max-width: 600px) {
            .container { width: 100% !important; margin: 0 !important; border-radius: 0 !important; }
            .content { padding: 32px 20px !important; }
            .header { padding: 32px 20px !important; }
            .coupon-box { padding: 16px !important; }
            .button { width: 100% !important; display: block !important; text-align: center !important; }
        }
    </style>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f7;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #f5f5f7;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <!-- Main Container -->
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="container" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);">

                    <!-- Header with Logo -->
                    <tr>
                        <td class="header" style="background: linear-gradient(135deg, #FF8C42 0%, #FF6B35 100%); padding: 48px 40px; text-align: center;">
                            <!-- Logo -->
                            <div style="margin-bottom: 16px;">
                                <span style="color: #ffffff; font-size: 32px; font-weight: 700; letter-spacing: -0.5px;">Yoho Mobile</span>
                            </div>
                            <h1 style="margin: 0; color: #ffffff; font-size: 26px; font-weight: 600; line-height: 1.3;">We saved your cart for you 🛒</h1>
                        </td>
                    </tr>

                    <!-- Main Content -->
                    <tr>
                        <td class="content" style="padding: 48px 40px;">
                            <!-- Greeting -->
                            <p style="margin: 0 0 24px; color: #1a1a1a; font-size: 18px; line-height: 1.6;">
                                Hi <strong style="color: #FF6B35;">richard2900@outlook.com</strong>,
                            </p>

                            <p style="margin: 0 0 32px; color: #4a4a4a; font-size: 16px; line-height: 1.7;">
                                Looks like you didn't finish checking out on Yoho Mobile. No worries — your cart's still waiting for you!
                            </p>

                            <!-- Coupon Box -->
                            <div class="coupon-box" style="background: linear-gradient(135deg, #FFF8F0 0%, #FFEEE0 100%); border: 2px dashed #FF8C42; border-radius: 12px; padding: 24px; text-align: center; margin: 32px 0;">
                                <div style="font-size: 28px; margin-bottom: 8px;">🎁</div>
                                <p style="margin: 0 0 12px; color: #8B4513; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Exclusive Offer</p>
                                <p style="margin: 0 0 16px; color: #1a1a1a; font-size: 18px; font-weight: 500;">
                                    Use code <span style="background-color: #FF6B35; color: #ffffff; padding: 4px 12px; border-radius: 6px; font-weight: 700; font-family: 'Courier New', monospace; font-size: 20px;">YOHO2025</span> for 10% off
                                </p>
                                <p style="margin: 0; color: #666666; font-size: 13px;">Limited time offer — don't miss out!</p>
                            </div>

                            <!-- Primary CTA Button -->
                            <div style="text-align: center; margin: 40px 0;">
                                <a href="#" class="button" style="display: inline-block; background: linear-gradient(135deg, #FF8C42 0%, #FF6B35 100%); color: #ffffff; text-decoration: none; padding: 18px 48px; border-radius: 50px; font-weight: 600; font-size: 17px; box-shadow: 0 8px 24px rgba(255, 107, 53, 0.35);">
                                    Resume Checkout →
                                </a>
                            </div>

                            <!-- Divider -->
                            <div style="border-top: 1px solid #e8e8e8; margin: 40px 0;"></div>

                            <!-- Feedback Section -->
                            <div style="background-color: #f8f9fa; border-radius: 12px; padding: 28px; margin: 32px 0;">
                                <h3 style="margin: 0 0 16px; color: #1a1a1a; font-size: 18px; font-weight: 600;">Having trouble paying?</h3>
                                <p style="margin: 0 0 24px; color: #666666; font-size: 15px; line-height: 1.6;">
                                    If something didn't work at checkout, tell us what happened — we're improving this flow every day.
                                </p>

                                <a href="#" style="display: inline-block; background-color: #ffffff; color: #FF6B35; text-decoration: none; padding: 14px 32px; border-radius: 50px; font-weight: 600; font-size: 15px; border: 2px solid #FF6B35;">
                                    Submit Quick Feedback
                                </a>
                            </div>

                            <!-- Help Info -->
                            <div style="margin: 32px 0 0;">
                                <p style="margin: 0 0 16px; color: #666666; font-size: 14px; font-weight: 500;">To help us fix it faster, please share:</p>
                                <ul style="margin: 0; padding-left: 20px; color: #666666; font-size: 14px; line-height: 2;">
                                    <li>Your device (iOS, Android, or Web)</li>
                                    <li>App version or browser (Safari, Chrome, etc.)</li>
                                    <li>The steps you took</li>
                                    <li>Optional: a short screen recording</li>
                                </ul>
                            </div>

                            <!-- Reward Note -->
                            <div style="margin-top: 28px; padding: 16px 20px; background: linear-gradient(90deg, #f0fdf4 0%, #dcfce7 100%); border-radius: 8px; border-left: 4px solid #22c55e;">
                                <p style="margin: 0; color: #166534; font-size: 14px; line-height: 1.6;">
                                    💰 <strong>Verified reports may qualify for a small cash reward (up to US$100).</strong>
                                </p>
                            </div>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="background-color: #f8f9fa; padding: 32px 40px; text-align: center; border-top: 1px solid #e8e8e8;">
                            <p style="margin: 0 0 8px; color: #1a1a1a; font-size: 16px; font-weight: 600;">Yoho Mobile</p>
                            <p style="margin: 0 0 16px; color: #999999; font-size: 13px;">Stay connected, wherever you go</p>
                            <p style="margin: 0; color: #bbbbbb; font-size: 12px; line-height: 1.6;">
                                You're receiving this because you added items to your cart on Yoho Mobile.<br>
                                Questions? Reply to this email or contact support@yohomobile.com
                            </p>
                        </td>
                    </tr>

                </table>

                <!-- Footer Outside Container -->
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px; margin-top: 24px;">
                    <tr>
                        <td align="center" style="padding: 0 20px;">
                            <p style="margin: 0; color: #999999; font-size: 12px; line-height: 1.6;">
                                Yoho Mobile Inc. · <a href="#" style="color: #999999; text-decoration: underline;">Unsubscribe</a> · <a href="#" style="color: #999999; text-decoration: underline;">Privacy Policy</a>
                            </p>
                        </td>
                    </tr>
                </table>

            </td>
        </tr>
    </table>
</body>
</html>
`.trim();

// 纯文本版本
const text = `
Hi richard2900@outlook.com,

Looks like you didn't finish checking out on Yoho Mobile. No worries — your cart's still waiting for you!

🎁 EXCLUSIVE OFFER
Use code YOHO2025 for 10% off your next order!
Limited time offer — don't miss out!

[Resume Checkout]

---

Having trouble paying?

If something didn't work at checkout, tell us what happened — we're improving this flow every day.

[Submit Quick Feedback]

To help us fix it faster, please share:
- Your device (iOS, Android, or Web)
- App version or browser (Safari, Chrome, etc.)
- The steps you took
- Optional: a short screen recording

💰 Verified reports may qualify for a small cash reward (up to US$100).

---

Yoho Mobile
Stay connected, wherever you go

You're receiving this because you added items to your cart on Yoho Mobile.
Questions? Reply to this email or contact support@yohomobile.com
`.trim();

// 发送邮件
async function sendEmail() {
    const transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: {
            user: config.user,
            pass: config.password,
        },
    });

    const info = await transporter.sendMail({
        from: config.from,
        to: 'hao.chen@yohomobile.com',
        subject: 'We saved your cart for you 🛒',
        html,
        text,
        headers: {
            'X-Priority': '1',
            'Importance': 'high'
        }
    });
    console.log('Message ID:', info.messageId);
    console.log('Accepted:', info.accepted);
    console.log('Rejected:', info.rejected);

    console.log('✅ Email sent successfully to hao.chen@yohomobile.com');
}

sendEmail().catch(console.error);
