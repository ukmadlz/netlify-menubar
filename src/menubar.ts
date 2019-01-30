import {
  app,
  Menu,
  MenuItemConstructorOptions,
  Notification,
  shell,
  Tray
} from 'electron'; // tslint:disable-line no-implicit-dependencies
import settings from 'electron-settings';
import { POLL_DURATIONS } from './config';
import Connection from './connection';
import ICONS from './icons';
import { getCheckboxMenu, getDeploysMenu, getSitesMenu } from './menus';
import Netlify, { INetlifyDeploy, INetlifySite, INetlifyUser } from './netlify';
import {
  getFormattedDeploys,
  getNotificationOptions,
  getSuspendedDeployCount
} from './util';

interface IJsonObject {
  [x: string]: JsonValue;
}

interface IJsonArray extends Array<JsonValue> {} // tslint:disable-line no-empty-interface
type JsonValue = string | number | boolean | null | IJsonArray | IJsonObject;

export interface IAppSettings {
  launchAtStart: boolean;
  pollInterval: number;
  showNotifications: boolean;
  currentSiteId: string | null;
}

interface IAppState {
  currentSite?: INetlifySite;
  menuIsOpen: boolean;
  previousDeploy: INetlifyDeploy | null;
  updateAvailable: boolean;
}

export interface IAppDeploys {
  pending: INetlifyDeploy[];
  ready: INetlifyDeploy[];
}

interface IAppNetlifyData {
  deploys: IAppDeploys;
  sites: INetlifySite[];
  user?: INetlifyUser;
}

const DEFAULT_SETTINGS: IAppSettings = {
  currentSiteId: null,
  launchAtStart: false,
  pollInterval: 10000,
  showNotifications: false
};

export default class UI {
  private apiClient: Netlify;
  private connection: Connection;
  private state: IAppState;
  private tray: Tray;
  private settings: IAppSettings;
  private netlifyData: IAppNetlifyData;

  public constructor({
    apiClient,
    connection
  }: {
    apiClient: Netlify;
    connection: Connection;
  }) {
    this.tray = new Tray(ICONS.loading);
    this.apiClient = apiClient;
    this.connection = connection;

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(settings.getAll() as {})
    };

    this.netlifyData = {
      deploys: { pending: [], ready: [] },
      sites: []
    };

    this.state = {
      menuIsOpen: false,
      previousDeploy: null,
      updateAvailable: false
    };

    this.setup().then(() => {
      const repeat = () => {
        setTimeout(async () => {
          await this.updateDeploys();
          repeat();
        }, this.settings.pollInterval);
      };

      repeat();
    });
  }

  public setState(state: Partial<IAppState>) {
    this.state = { ...this.state, ...state };
    this.render();
  }

  private async setup(): Promise<void> {
    await this.fetchData(async () => {
      if (!this.settings.currentSiteId) {
        this.settings.currentSiteId = await this.getFallbackSiteId();
      }

      const [currentUser, sites, deploys] = await Promise.all([
        this.apiClient.getCurrentUser(),
        this.apiClient.getSites(),
        this.apiClient.getSiteDeploys(this.settings.currentSiteId)
      ]);

      this.netlifyData = {
        deploys: getFormattedDeploys(deploys),
        sites,
        user: {
          email: currentUser.email
        }
      };

      this.state.currentSite = this.getSite(this.settings.currentSiteId);
    });
  }

  private getSite(siteId: string): INetlifySite {
    return (
      this.netlifyData.sites.find(({ id }) => id === siteId) ||
      this.netlifyData.sites[0]
    );
  }

  private async getFallbackSiteId(): Promise<string> {
    const sites = await this.apiClient.getSites();
    return sites[0].id;
  }

  private async fetchData(fn: () => void): Promise<void> {
    if (this.connection.isOnline) {
      this.tray.setImage(ICONS.loading);

      // catch possible network hickups
      try {
        await fn();
        this.evaluateDeployState();
        if (this.state.previousDeploy) {
          this.tray.setImage(ICONS[this.state.previousDeploy.state]);
        }
      } catch (e) {
        this.tray.setImage(ICONS.offline);
      }
    } else {
      this.tray.setImage(ICONS.offline);
    }

    this.render();
  }

  private updateDeploys(): Promise<void> {
    return this.fetchData(async () => {
      if (this.settings.currentSiteId) {
        const deploys = await this.apiClient.getSiteDeploys(
          this.settings.currentSiteId
        );

        this.netlifyData.deploys = getFormattedDeploys(deploys);
      }
    });
  }

  private evaluateDeployState(): void {
    const { deploys } = this.netlifyData;
    const { previousDeploy, currentSite } = this.state;

    let currentDeploy: INetlifyDeploy | null = null;

    if (deploys.pending.length) {
      currentDeploy = deploys.pending[deploys.pending.length - 1];
    } else if (deploys.ready.length) {
      currentDeploy = deploys.ready[0];
    }

    // cover edge case for new users
    // who don't have any deploys yet
    if (currentDeploy === null) {
      return;
    }

    if (this.settings.showNotifications && previousDeploy) {
      const notificationOptions = getNotificationOptions(
        previousDeploy,
        currentDeploy
      );

      if (notificationOptions) {
        const notification = new Notification(notificationOptions);

        notification.on('click', event => {
          if (currentSite && currentDeploy) {
            shell.openExternal(
              `https://app.netlify.com/sites/${currentSite.name}/deploys/${
                currentDeploy.id
              }`
            );
          }
        });

        // notifications with an attached click handler
        // won't disappear by itself
        // -> close it after certain timeframe automatically
        notification.on('show', () =>
          setTimeout(() => notification.close(), 4000)
        );
        notification.show();
      }
    }

    this.state.previousDeploy = currentDeploy;
  }

  private saveSetting(key: string, value: JsonValue): void {
    settings.set(key, value);
    this.settings[key] = value;
    this.render();
  }

  private async render(): Promise<void> {
    if (!this.state.currentSite) {
      console.error('No current site found'); // tslint:disable-line no-console
      return;
    }

    this.tray.setTitle(
      getSuspendedDeployCount(this.netlifyData.deploys.pending.length)
    );

    this.renderMenu(this.state.currentSite);
  }

  private async renderMenu(currentSite: INetlifySite): Promise<void> {
    if (!this.connection.isOnline) {
      return this.tray.setContextMenu(
        Menu.buildFromTemplate([
          {
            enabled: false,
            label: "Looks like you're offline..."
          }
        ])
      );
    }

    const { sites, deploys, user } = this.netlifyData;
    const { pollInterval } = this.settings;

    const menu = Menu.buildFromTemplate([
      {
        enabled: false,
        label: `Netlify Menubar ${app.getVersion()}`
      },
      { type: 'separator' },
      {
        enabled: false,
        label: user && user.email
      },
      { type: 'separator' },
      {
        label: 'Choose site:',
        submenu: getSitesMenu({
          currentSite,
          onItemClick: siteId => {
            this.saveSetting('currentSiteId', siteId);
            this.state.previousDeploy = null;
            this.state.currentSite = this.getSite(siteId);
            this.updateDeploys();
          },
          sites
        })
      },
      { type: 'separator' },
      {
        enabled: false,
        label: `${currentSite.url.replace(/https?:\/\//, '')}`
      },
      {
        click: () => shell.openExternal(currentSite.url),
        label: 'Go to Site'
      },
      {
        click: () => shell.openExternal(currentSite.admin_url),
        label: 'Go to Admin'
      },
      {
        enabled: false,
        label: '—'
      },
      {
        label: 'Deploys',
        submenu: getDeploysMenu({
          deploys,
          onItemClick: deployId =>
            shell.openExternal(
              `https://app.netlify.com/sites/${
                currentSite.name
              }/deploys/${deployId}`
            )
        })
      },
      {
        click: async () => {
          this.fetchData(async () => {
            await this.apiClient.createSiteBuild(currentSite.id);
            this.updateDeploys();
          });
        },
        label: 'Trigger new deploy'
      },
      { type: 'separator' },
      {
        label: 'Settings',
        submenu: [
          ...getCheckboxMenu({
            items: [
              { key: 'launchAtStart', label: 'Launch at Start' },
              { key: 'showNotifications', label: 'Show notifications' }
            ],
            onItemClick: (key, value) => this.saveSetting(key, !value),
            settings: this.settings
          }),
          {
            label: 'Poll interval',
            submenu: POLL_DURATIONS.map(
              ({ label, value }): MenuItemConstructorOptions => ({
                checked: pollInterval === value,
                click: () => this.saveSetting('pollInterval', value),
                label,
                type: 'radio'
              })
            )
          }
        ]
      },
      { type: 'separator' },
      {
        click: () =>
          shell.openExternal(
            `https://github.com/stefanjudis/netlify-menubar/releases/tag/v${app.getVersion()}`
          ),
        label: 'Changelog'
      },
      {
        click: () =>
          shell.openExternal(
            'https://github.com/stefanjudis/netlify-menubar/issues/new'
          ),
        label: 'Give feedback'
      },
      { type: 'separator' },
      ...(this.state.updateAvailable
        ? [
            {
              click: () => {
                app.relaunch();
                app.exit();
              },
              label: 'Restart and update...'
            }
          ]
        : []),
      { label: 'Quit Netlify Menubar', role: 'quit' }
    ]);

    menu.on('menu-will-show', () => (this.state.menuIsOpen = true));
    menu.on('menu-will-close', () => {
      this.state.menuIsOpen = false;
      // queue it behind other event handlers because otherwise
      // the menu-rerender will cancel ongoing click handlers
      setImmediate(() => this.render());
    });

    // avoid the menu to close in case the user has it open
    if (!this.state.menuIsOpen) {
      // tslint:disable-next-line
      console.log('UI: rerending menu');
      this.tray.setContextMenu(menu);
    }
  }
}
