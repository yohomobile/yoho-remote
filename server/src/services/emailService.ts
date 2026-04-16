/**
 * Email Service - 邮件发送服务
 * 使用 Stalwart SMTP 发送邮件
 */

import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'

/**
 * HTML 转义函数，防止 XSS 攻击
 */
function escapeHtml(unsafe: string): string {
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
}

export interface EmailConfig {
    host: string
    port: number
    secure: boolean
    user: string
    password: string
    from: string
}

export interface SendEmailOptions {
    to: string
    subject: string
    html: string
    text?: string
}

export function getOrgInvitationAcceptUrl(invitationId: string): string {
    return `${process.env.WEB_URL || 'https://remote.yohomobile.dev'}/invitations/accept/${invitationId}`
}

class EmailService {
    private transporter: Transporter | null = null
    private config: EmailConfig | null = null

    /**
     * 初始化邮件服务
     */
    initialize(config: EmailConfig): void {
        this.config = config
        this.transporter = nodemailer.createTransport({
            host: config.host,
            port: config.port,
            secure: config.secure,
            auth: {
                user: config.user,
                pass: config.password,
            },
        })
    }

    /**
     * 发送邮件
     */
    async sendEmail(options: SendEmailOptions): Promise<void> {
        if (!this.transporter || !this.config) {
            throw new Error('Email service not initialized')
        }

        await this.transporter.sendMail({
            from: this.config.from,
            to: options.to,
            subject: options.subject,
            html: options.html,
            text: options.text,
        })
    }

    /**
     * 发送组织邀请邮件
     */
    async sendOrgInvitation(params: {
        to: string
        orgName: string
        orgSlug: string
        inviterEmail: string
        invitationId: string
        role: string
        expiresAt: number
    }): Promise<void> {
        // HTML 转义所有用户输入，防止 XSS
        const safeOrgName = escapeHtml(params.orgName)
        const safeOrgSlug = escapeHtml(params.orgSlug)
        const safeInviterEmail = escapeHtml(params.inviterEmail)
        const safeRole = escapeHtml(params.role)

        const acceptUrl = getOrgInvitationAcceptUrl(params.invitationId)

        const expiresDate = new Date(params.expiresAt).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        })

        const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Organization Invitation</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f7;">
    <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);">
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
            <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 600;">You've Been Invited!</h1>
        </div>

        <!-- Content -->
        <div style="padding: 40px 30px;">
            <p style="margin: 0 0 20px; color: #333333; font-size: 16px; line-height: 1.6;">
                Hi there,
            </p>

            <p style="margin: 0 0 20px; color: #333333; font-size: 16px; line-height: 1.6;">
                <strong>${safeInviterEmail}</strong> has invited you to join the organization <strong>${safeOrgName}</strong> on Yoho Remote.
            </p>

            <div style="background-color: #f8f9fa; border-left: 4px solid #667eea; padding: 16px 20px; margin: 24px 0; border-radius: 4px;">
                <div style="margin-bottom: 8px;">
                    <strong style="color: #495057; font-size: 14px;">Organization:</strong>
                    <span style="color: #212529; font-size: 14px; margin-left: 8px;">${safeOrgName}</span>
                </div>
                <div style="margin-bottom: 8px;">
                    <strong style="color: #495057; font-size: 14px;">Slug:</strong>
                    <span style="color: #212529; font-size: 14px; margin-left: 8px; font-family: monospace;">${safeOrgSlug}</span>
                </div>
                <div>
                    <strong style="color: #495057; font-size: 14px;">Role:</strong>
                    <span style="color: #212529; font-size: 14px; margin-left: 8px; text-transform: capitalize;">${safeRole}</span>
                </div>
            </div>

            <!-- CTA Button -->
            <div style="text-align: center; margin: 32px 0;">
                <a href="${acceptUrl}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);">
                    Accept Invitation
                </a>
            </div>

            <p style="margin: 24px 0 8px; color: #6c757d; font-size: 14px; line-height: 1.6;">
                Or copy and paste this link into your browser:
            </p>
            <p style="margin: 0; padding: 12px; background-color: #f8f9fa; border-radius: 4px; word-break: break-all; font-family: monospace; font-size: 12px; color: #495057;">
                ${acceptUrl}
            </p>

            <p style="margin: 24px 0 0; color: #6c757d; font-size: 14px; line-height: 1.6;">
                This invitation will expire on <strong>${expiresDate}</strong>.
            </p>
        </div>

        <!-- Footer -->
        <div style="background-color: #f8f9fa; padding: 24px 30px; text-align: center; border-top: 1px solid #e9ecef;">
            <p style="margin: 0 0 8px; color: #6c757d; font-size: 13px;">
                Yoho Remote - AI-powered remote collaboration
            </p>
            <p style="margin: 0; color: #adb5bd; font-size: 12px;">
                If you didn't expect this invitation, you can safely ignore this email.
            </p>
        </div>
    </div>
</body>
</html>
        `.trim()

        const text = `
You've been invited to join ${params.orgName}!

${params.inviterEmail} has invited you to join the organization "${params.orgName}" (${params.orgSlug}) on Yoho Remote as a ${params.role}.

Accept the invitation by visiting:
${acceptUrl}

This invitation will expire on ${expiresDate}.

If you didn't expect this invitation, you can safely ignore this email.

---
Yoho Remote - AI-powered remote collaboration
        `.trim()

        await this.sendEmail({
            to: params.to,
            subject: `Invitation to join ${safeOrgName} on Yoho Remote`,
            html,
            text,
        })
    }
}

// 导出单例
export const emailService = new EmailService()
