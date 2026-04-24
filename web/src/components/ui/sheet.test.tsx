import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from './sheet'

describe('Sheet primitive', () => {
    test('renders nothing when closed so the drawer does not leak into the DOM', () => {
        const html = renderToStaticMarkup(
            <Sheet open={false} onOpenChange={() => {}}>
                <SheetContent>
                    <SheetHeader>
                        <SheetTitle>Person detail</SheetTitle>
                    </SheetHeader>
                </SheetContent>
            </Sheet>,
        )
        expect(html).not.toContain('Person detail')
    })

    test('exports the expected primitive surface', () => {
        expect(Sheet).toBeDefined()
        expect(SheetContent).toBeDefined()
        expect(SheetHeader).toBeDefined()
        expect(SheetTitle).toBeDefined()
    })
})
