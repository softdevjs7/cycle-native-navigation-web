import xs, {Stream} from 'xstream';
import concat from 'xstream/extra/concat';
import dropRepeats from 'xstream/extra/dropRepeats';
import {makeReactNativeDriver} from '@cycle/react-native';
import {Drivers, setupReusable} from '@cycle/run';
import {InternalInstances} from '@cycle/state/lib/cjs/types';
import {createElement as $, ReactElement} from 'react';
import isolate from '@cycle/isolate';
import {View, StyleSheet, AppRegistry} from 'react-native';
import {
  ComponentDidAppearEvent,
  ComponentDidDisappearEvent,
  Layout,
  LayoutComponent,
} from 'react-native-navigation';
import {makeCollection, withState, Lens, Reducer} from '@cycle/state';
import {
  Command,
  FrameSources,
  Stack,
  MainDrivers,
  MainSinks,
  MainSources,
  ScreenSinks,
  ScreenSources,
  ListSinks,
  LayoutInstance,
  Screens,
} from './types';
import {Frame, GlobalScreen} from './symbols';
import {NavSource} from './NavSource';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignSelf: 'stretch',
    flexDirection: 'column',
  },

  shown: {
    height: '100%',
  },

  hidden: {
    display: 'none',
  },
});

const shownWM = new WeakMap();
const hiddenWM = new WeakMap();

function logAndThrow(err: string): never {
  console.error(err);
  throw new Error(err);
}

function neverComplete<T>(stream: Stream<T>): Stream<T> {
  return xs.merge(stream, xs.never());
}

interface MergeableSinks {
  [s: string]: Stream<any> | undefined;
}
function mergeAllSinksExcept(
  manySinks: Array<MergeableSinks>,
  ignored: Array<string>,
) {
  const resultSinks = {} as MergeableSinks;
  for (const [i, sinks] of manySinks.entries()) {
    const subsequents = manySinks.slice(i + 1);
    for (const channel of Object.keys(sinks)) {
      if (ignored.includes(channel) || resultSinks[channel]) continue;

      if (i === manySinks.length - 1) {
        // last one, nothing to merge
        resultSinks[channel] = sinks[channel]!;
      } else {
        resultSinks[channel] = xs.merge(
          sinks[channel]!,
          ...subsequents.map((zinkz) => zinkz[channel] ?? xs.never()),
        );
      }
    }
  }
  return resultSinks;
}

export function run(screens: Screens, drivers: Drivers, initialLayout: Layout) {
  let _i = 1;
  function componentNameToComponentId(name?: string) {
    return `${name ?? ''}---${_i++}`;
  }
  function componentIdToComponentName(id: string) {
    return id.split('---')[0];
  }

  function instantiateLayout(layout: LayoutComponent): LayoutInstance {
    return {...layout, id: componentNameToComponentId(layout.name as string)};
  }

  const APP_KEY = 'cyclenativenavigationweb';

  const driversPlus: MainDrivers = {
    ...drivers,
    screen: makeReactNativeDriver(APP_KEY),
  };

  function main(sources: MainSources): MainSinks {
    const frameEnabled$ = sources.navigationStack.stream
      .map((stack) => {
        if (stack.length < 1) return true;
        const top = stack[stack.length - 1];
        if (!top.options) return true;
        if (!top.options.sideMenu) return true;
        if (!top.options.sideMenu.left) return true;
        return top.options.sideMenu.left.enabled !== false;
      })
      .compose(dropRepeats());

    const navSources = new Map<string, NavSource>();
    const globalDidAppear$ = xs.create<ComponentDidAppearEvent>();
    const globalDidDisappear$ = xs.create<ComponentDidDisappearEvent>();
    const globalBack$ = xs.create<unknown>({
      start(listener) {
        (this as any).fn = () => {
          listener.next(null);
        };
        window.addEventListener(
          'cyclenativenavigationweb-back',
          (this as any).fn,
        );
      },
      stop() {
        window.removeEventListener(
          'cyclenativenavigationweb-back',
          (this as any).fn,
        );
      },
    });

    const listItemChannels = Object.keys(driversPlus).concat('navigation');
    const List: (so: ScreenSources) => ListSinks = makeCollection({
      channel: 'navigationStack',
      itemFactory: (childState: LayoutComponent) => {
        const component = screens[childState.name];
        if (!component) {
          logAndThrow('no component for ' + childState.name);
        }
        const navSource = new NavSource(
          globalDidAppear$,
          globalDidDisappear$,
          globalBack$,
        );
        navSources.set(childState.id!, navSource);
        return function wrapComponent(sources: ScreenSources): ScreenSinks {
          const innerSources = {
            ...sources,
            navigation: navSource,
            props: xs
              .of(childState.passProps)
              .compose(neverComplete)
              .remember(),
          };
          const innerSinks = component(innerSources);
          innerSinks['_passProps'] = childState.passProps;
          return innerSinks;
        };
      },
      itemKey: (childState: LayoutComponent) => childState.id!,
      itemScope: (key) => key,
      collectSinks: (instances) => {
        const ist$ = instances['_instances$'] as Stream<InternalInstances<any>>;
        const currentChildren = new Set<string>();
        ist$.addListener({
          next: ({dict}) => {
            for (const id of dict.keys()) {
              if (!currentChildren.has(id)) {
                currentChildren.add(id);
                const componentName = componentIdToComponentName(id);
                const passProps = dict.get(id)['_passProps'];
                globalDidAppear$._n({
                  componentId: id,
                  componentName,
                  passProps,
                });
                navSources.get(id)?._didAppear._n(null);
              }
            }
            for (const id of currentChildren.keys()) {
              if (!dict.has(id)) {
                currentChildren.delete(id);
                const componentName = componentIdToComponentName(id);
                globalDidDisappear$._n({componentId: id, componentName});
                navSources.get(id)?._didDisappear._n(null);
                navSources.delete(id);
              }
            }
          },
        });
        const sinks = {} as any;
        for (const channel of listItemChannels) {
          if (channel === 'screen') {
            sinks[channel] = instances.pickCombine(channel).map((itemVNodes) =>
              itemVNodes.map((vnode, i) => {
                if (i === itemVNodes.length - 1) {
                  if (!shownWM.has(vnode)) {
                    shownWM.set(
                      vnode,
                      $(View, {key: 'c' + i, style: styles.shown}, vnode),
                    );
                  }
                  return shownWM.get(vnode)!;
                } else {
                  if (!hiddenWM.has(vnode)) {
                    hiddenWM.set(
                      vnode,
                      $(View, {key: 'c' + i, style: styles.hidden}, vnode),
                    );
                  }
                  return hiddenWM.get(vnode)!;
                }
              }),
            );
          } else if (channel === '_passProps') {
            // ignore, it's not a stream
          } else {
            sinks[channel] = instances.pickMerge(channel);
          }
        }
        return sinks;
      },
    });

    const listSinks = List(sources);

    const unframedVDOM$ = listSinks.screen.map(
      (children) =>
        $(View, {style: styles.container}, ...children) as ReactElement,
    );

    const identityLens: Lens<any, any> = {
      get: (x) => x,
      set: (_, x) => x,
    };

    const frameNavSource = new NavSource(
      globalDidAppear$,
      globalDidDisappear$,
      globalBack$,
    );
    const frameSources: FrameSources = {
      ...sources,
      navigation: frameNavSource,
      children: listSinks.screen,
    };
    const frameSinks: Partial<ScreenSinks> = screens[Frame]
      ? (isolate(screens[Frame]!, {
          '*': 'frame',
          navigationStack: identityLens,
        })(frameSources) as ScreenSinks)
      : {};

    const globalNavSource = new NavSource(
      globalDidAppear$,
      globalDidDisappear$,
      globalBack$,
    );
    const globalSources = {
      ...sources,
      navigation: globalNavSource,
    };
    const globalSinks: Omit<ScreenSinks, 'screen'> = screens[GlobalScreen]
      ? isolate(screens[GlobalScreen]!, {
          '*': 'globalScreen',
          navigationStack: identityLens,
        })(globalSources)
      : {};

    const vdom$ = screens[Frame]
      ? xs
          .combine(
            frameEnabled$,
            frameSinks.screen!.startWith(null as any),
            unframedVDOM$,
          )
          .map(([frameEnabled, framedVDOM, unframedVDOM]) =>
            frameEnabled ? framedVDOM : unframedVDOM,
          )
      : unframedVDOM$;

    frameEnabled$.addListener({
      next: (frameEnabled) => {
        if (frameEnabled) {
          frameNavSource._didAppear._n(null);
        } else {
          frameNavSource._didDisappear._n(null);
        }
      },
    });

    function updateIsTops(stack: Stack) {
      if (stack.length === 1) {
        const navSource = navSources.get(stack[0].id!);
        if (navSource) navSource._isTop = true;
      } else {
        for (const item of stack) {
          const navSource = navSources.get(item.id);
          if (navSource) navSource._isTop = false;
        }
        const top = stack[stack.length - 1];
        const topNavSource = navSources.get(top.id);
        if (topNavSource) topNavSource._isTop = true;
      }
    }

    const stackReducer$ = concat(
      xs.of<Reducer<Stack>>((_prev) => {
        const initialComponent = initialLayout.stack?.children?.[0].component;
        if (!initialComponent) {
          logAndThrow('initialLayout only supports stack.children[0]');
        }
        return [instantiateLayout(initialComponent)];
      }),

      xs
        .merge(
          listSinks.navigation!,
          frameSinks.navigation ?? xs.never(),
          globalSinks.navigation ?? xs.never(),
        )
        .map((cmd: Command) => (prevStack) => {
          if (cmd.type === 'push') {
            const nextStack = [
              ...prevStack!,
              instantiateLayout(cmd.layout.component!),
            ];
            updateIsTops(nextStack);
            return nextStack;
          }

          if (cmd.type === 'setStackRoot') {
            let stack = cmd.layout.sideMenu?.center.stack;
            if (!stack) {
              stack = cmd.layout.stack;
            }
            if (!stack) {
              logAndThrow(
                'setStackRoot could not find stack from ' +
                  JSON.stringify(cmd.layout),
              );
            }
            const component = stack.children?.[0].component;
            if (!component) {
              logAndThrow(
                'setStackRoot could not find component from ' +
                  JSON.stringify(stack.children),
              );
            }
            const nextStack = [instantiateLayout(component)];
            updateIsTops(nextStack);
            return nextStack;
          }

          if (cmd.type === 'pop') {
            if (prevStack!.length === 1) return prevStack;
            prevStack!.pop();
            const nextStack = [...prevStack!];
            updateIsTops(nextStack);
            return nextStack;
          }

          if (cmd.type === 'popToRoot') {
            if (prevStack!.length > 0) {
              const nextStack = [prevStack![0]];
              updateIsTops(nextStack);
              return nextStack;
            }
            return [];
          }

          console.warn('unknown nav command', cmd);
          return prevStack;
        }),
    );

    const otherSinks = mergeAllSinksExcept(
      [listSinks, frameSinks, globalSinks],
      ['screen', 'navigationStack', 'navigation'],
    );

    return {
      ...otherSinks,
      screen: vdom$,
      navigationStack: stackReducer$,
    };
  }

  const engine = setupReusable(driversPlus);

  engine.run(withState(main, 'navigationStack')(engine.sources));

  AppRegistry.runApplication(APP_KEY, {
    rootTag: document.getElementById('app'),
  });
}
