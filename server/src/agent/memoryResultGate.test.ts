import { describe, expect, test } from 'bun:test'
import { evaluateRecallConsumption, evaluateSkillSearchConsumption } from './memoryResultGate'

describe('memoryResultGate', () => {
    test('allows skill_search direct use only for use_results with local match and sufficient confidence', () => {
        expect(evaluateSkillSearchConsumption({
            suggestedNextAction: 'use_results',
            hasLocalMatch: true,
            confidence: 0.8,
        })).toMatchObject({
            directUseAllowed: true,
        })
    })

    test('marks no-match or low-confidence skill_search results as not directly usable', () => {
        expect(evaluateSkillSearchConsumption({
            suggestedNextAction: 'no-match',
            hasLocalMatch: false,
            confidence: 0.9,
        })).toMatchObject({
            directUseAllowed: false,
        })

        expect(evaluateSkillSearchConsumption({
            suggestedNextAction: 'use_results',
            hasLocalMatch: true,
            confidence: 0.4,
        })).toMatchObject({
            directUseAllowed: false,
        })
    })

    test('honors explicit directUseAllowed=false for skill_search even when legacy fields look safe', () => {
        const decision = evaluateSkillSearchConsumption({
            directUseAllowed: false,
            suggestedNextAction: 'use_results',
            hasLocalMatch: true,
            confidence: 0.95,
        })
        expect(decision).toMatchObject({
            directUseAllowed: false,
        })
        expect(decision.reason).toContain('directUseAllowed=false')
    })

    test('blocks skill_search when scope does not match', () => {
        const decision = evaluateSkillSearchConsumption({
            directUseAllowed: true,
            suggestedNextAction: 'use_results',
            hasLocalMatch: true,
            confidence: 0.95,
            scope: {
                matched: false,
            },
        })

        expect(decision).toMatchObject({
            directUseAllowed: false,
        })
        expect(decision.reason).toContain('scope.matched=false')
    })

    test('rejects unreliable recall results before they become facts', () => {
        expect(evaluateRecallConsumption({
            answer: '',
            filesSearched: 0,
        })).toMatchObject({
            reliable: false,
        })

        expect(evaluateRecallConsumption({
            answer: '旧项目里的结论',
            filesSearched: 1,
            confidence: 0.2,
        })).toMatchObject({
            reliable: false,
        })
    })

    test('honors explicit recall protocol blocks', () => {
        const explicit = evaluateRecallConsumption({
            isDirectlyUsable: false,
            answer: '看起来可用的旧结论',
            filesSearched: 1,
            confidence: 0.9,
        })
        expect(explicit).toMatchObject({
            reliable: false,
        })
        expect(explicit.reason).toContain('isDirectlyUsable=false')

        const scope = evaluateRecallConsumption({
            answer: '看起来可用的旧结论',
            filesSearched: 1,
            confidence: 0.9,
            scope: {
                matched: false,
            },
        })
        expect(scope).toMatchObject({
            reliable: false,
        })
        expect(scope.reason).toContain('scope.matched=false')

        const unmatched = evaluateRecallConsumption({
            answer: '看起来可用的旧结论',
            filesSearched: 1,
            confidence: 0.9,
            scope: {
                matched: true,
                unmatchedReasons: ['project mismatch'],
            },
        })
        expect(unmatched).toMatchObject({
            reliable: false,
        })
        expect(unmatched.reason).toContain('project mismatch')
    })

    test('requires an explicit positive result count by default', () => {
        const decision = evaluateRecallConsumption({
            answer: '有回答但没有结果数字段',
            confidence: 0.9,
        })
        expect(decision).toMatchObject({
            reliable: false,
        })
        expect(decision.reason).toContain('缺少 resultCount/filesSearched')
    })

    test('requires recall scope match when match terms are provided', () => {
        expect(evaluateRecallConsumption({
            answer: 'openId:user-1 的偏好是先给结论',
            filesSearched: 1,
            confidence: 0.8,
        }, {
            matchTerms: ['user-1'],
        })).toMatchObject({
            reliable: true,
        })

        expect(evaluateRecallConsumption({
            answer: '另一个人的偏好是先给结论',
            filesSearched: 1,
            confidence: 0.8,
        }, {
            matchTerms: ['user-1'],
        })).toMatchObject({
            reliable: false,
        })
    })
})
